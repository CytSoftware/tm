"""OAuth authorize hand-off, consent API, and connection management.

The browser-facing half of MCP OAuth. Three concerns:

**1. The authorize hand-off** (:class:`McpAuthorizationView`). We keep
django-oauth-toolkit's ``AuthorizationView`` — it owns request validation, PKCE,
``prompt=login/none``, ``skip_authorization`` and the silent re-approval
short-circuit — and override only the two places it would render or redirect to
its own UI:

* ``handle_no_permission`` — an anonymous user must be sent to the frontend's
  login page. Django's default puts ``next=/oauth/authorize/?…``, a *relative*
  path, which the frontend then resolves against its **own** origin, producing
  ``tm.cytsoftware.com/oauth/authorize/…`` → 404. We send an absolute backend
  URL instead, which is what the frontend's redirect allowlist expects.
* ``render_to_response`` — reached only when DOT has decided consent is actually
  needed. Instead of its stock template we redirect to the branded frontend
  page. Because everything upstream is untouched, ``skip_authorization`` and
  ``REQUEST_APPROVAL_PROMPT="auto"`` still short-circuit, so a reconnect or a
  token refresh never shows a screen.

**2. The consent API** (:class:`OAuthAuthorizeRequestView`). Backs that frontend
page. It re-runs DOT's own ``validate_authorization_request`` /
``create_authorization_response`` pair, both of which read their parameters from
``request.build_absolute_uri()``. So the frontend passes the **original query
string through verbatim** and we never reconstruct it field by field — which
also means client parameters we don't model (``resource``, ``nonce``, ``claims``)
survive untouched. Re-validating on POST rather than trusting echoed form fields
is a deliberate improvement on DOT's hidden-input approach.

**3. Connection management** (:class:`OAuthConnectionViewSet`,
:class:`McpAccessTokenViewSet`). Lets a user see which clients hold tokens for
their account and revoke them, and mint/revoke personal access tokens for
headless clients.
"""

from __future__ import annotations

import logging
from urllib.parse import urlencode

from django.conf import settings
from django.contrib.auth.views import redirect_to_login
from django.db.models import Count, Max, Min
from django.http import HttpResponseRedirect
from django.utils import timezone
from oauth2_provider.exceptions import FatalClientError, OAuthToolkitError
from oauth2_provider.models import (
    get_access_token_model,
    get_application_model,
    get_grant_model,
    get_refresh_token_model,
)
from oauth2_provider.oauth2_backends import get_oauthlib_core
from oauth2_provider.scopes import get_scopes_backend
from oauth2_provider.views.base import AuthorizationView
from rest_framework import status, viewsets
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import McpAccessToken, generate_mcp_token
from .serializers import (
    McpAccessTokenCreatedSerializer,
    McpAccessTokenCreateSerializer,
    McpAccessTokenSerializer,
)

logger = logging.getLogger(__name__)

Application = get_application_model()
AccessToken = get_access_token_model()
RefreshToken = get_refresh_token_model()
Grant = get_grant_model()

#: Frontend route that renders the consent screen.
CONSENT_PATH = "/oauth/consent"


def _frontend_url(path: str, query: str = "") -> str:
    base = settings.FRONTEND_URL.rstrip("/")
    return f"{base}{path}" + (f"?{query}" if query else "")


class McpAuthorizationView(AuthorizationView):
    """DOT's authorize view with the two UI touchpoints redirected at the SPA."""

    def handle_no_permission(self):
        """Send anonymous users to the frontend login page with an absolute ``next``.

        ``prompt=none`` is still DOT's business (it must answer the client with
        ``error=login_required`` rather than showing a login page), so defer to
        the parent for that case and only take over the plain redirect.
        """
        if self.request.GET.get("prompt") == "none":
            return super().handle_no_permission()

        # build_absolute_uri() keeps the scheme+host of *this* (backend) request,
        # including the full authorization query string. Django's default would
        # use get_full_path(), which is relative and therefore resolves against
        # the frontend origin once the login page reads it.
        return redirect_to_login(
            self.request.build_absolute_uri(),
            settings.LOGIN_URL,
            self.get_redirect_field_name(),
        )

    def render_to_response(self, context, **response_kwargs):
        """Redirect to the branded frontend consent page.

        Only reached when DOT actually wants consent — auto-approval and
        ``skip_authorization`` return before this — so reconnects stay silent.

        ``context`` may instead describe a validation error (DOT funnels those
        through ``error_response`` → ``render_to_response``); pass those to the
        frontend too so it can render a real message rather than a blank screen.
        """
        error = context.get("error")
        if error is not None:
            return HttpResponseRedirect(
                _frontend_url(
                    CONSENT_PATH,
                    urlencode({
                        "error": getattr(error, "error", "invalid_request"),
                        "error_description": getattr(error, "description", "") or "",
                    }),
                )
            )

        # Forward the original query string untouched so nothing is lost.
        return HttpResponseRedirect(
            _frontend_url(CONSENT_PATH, self.request.GET.urlencode())
        )


class OAuthAuthorizeRequestView(APIView):
    """JSON consent API for the frontend page.

    Talks to ``OAuthLibCore`` directly — the same object DOT's own
    ``AuthorizationView`` delegates to — rather than subclassing that view.
    Inheriting it alongside ``APIView`` looks tempting but breaks: it drags in
    ``FormMixin``, whose ``initial = {}`` class attribute shadows DRF's
    ``APIView.initial()`` method.

    * ``GET  /api/oauth/authorize-request/?<original query string>`` — describe
      the pending request.
    * ``POST /api/oauth/authorize-request/?<original query string>`` with
      ``{"allow": true|false}`` — decide it, returning the URL to navigate to.

    DRF's ``SessionAuthentication`` + ``IsAuthenticated`` (project defaults) do
    the job ``LoginRequiredMixin`` does on the browser view: an anonymous caller
    gets 403, not a redirect, because the consumer here is ``fetch()``.
    """

    http_method_names = ["get", "post"]

    def _validate(self):
        """Run DOT's validation against this request's query string.

        The oauthlib helpers read every parameter out of
        ``request.build_absolute_uri()``, which is exactly why the frontend
        forwards the original query string untouched: nothing has to be
        enumerated, so ``resource``, ``nonce`` and ``claims`` survive.
        """
        return get_oauthlib_core().validate_authorization_request(self.request._request)

    def get(self, request, *args, **kwargs):
        try:
            scopes, credentials = self._validate()
        except OAuthToolkitError as error:
            return self._error(error)

        try:
            application = Application.objects.get(client_id=credentials["client_id"])
        except Application.DoesNotExist:
            return Response(
                {"error": "invalid_client",
                 "error_description": "Unknown client_id."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        all_scopes = get_scopes_backend().get_all_scopes()
        previously_authorized = AccessToken.objects.filter(
            user=request.user, application=application, expires__gt=timezone.now()
        ).exists()

        return Response({
            "client_id": credentials["client_id"],
            "client_name": application.name,
            "redirect_uri": credentials["redirect_uri"],
            "scopes": [
                {"name": s, "description": all_scopes.get(s, s)} for s in scopes
            ],
            "previously_authorized": previously_authorized,
            "account": {
                "username": request.user.get_username(),
                "email": request.user.email,
                "full_name": request.user.get_full_name(),
            },
        })

    def post(self, request, *args, **kwargs):
        allow = bool(request.data.get("allow"))

        # Re-validate server-side rather than trusting anything the page echoes
        # back. The query string is the only input.
        try:
            scopes, credentials = self._validate()
        except OAuthToolkitError as error:
            return self._error(error)

        # Mirror AuthorizationView.form_valid's credential whitelist: oauthlib
        # rejects the extra keys that validation returns.
        allowed = (
            "client_id", "redirect_uri", "response_type", "state",
            "code_challenge", "code_challenge_method", "nonce", "claims",
        )
        creds = {k: v for k, v in credentials.items() if k in allowed and v}

        # create_authorization_response needs request.user to attribute the grant.
        django_request = request._request
        django_request.user = request.user

        try:
            uri, _headers, _body, _status = (
                get_oauthlib_core().create_authorization_response(
                    request=django_request,
                    # A *list*, not a space-joined string. oauthlib assigns this
                    # straight onto `request.scopes` with no normalisation, and
                    # DOT's validator then does `set(scopes)` — handing it a
                    # string yields a set of single characters and fails with
                    # `invalid_scope`.
                    scopes=scopes,
                    credentials=creds,
                    allow=allow,
                )
            )
        except OAuthToolkitError as error:
            # A denial arrives here as AccessDeniedError. Its redirect URI *is*
            # the correct answer — sending the client back with
            # `error=access_denied` is how it learns it was refused instead of
            # hanging. FatalClientError is different: a bad client_id or
            # redirect_uri must never be redirected to.
            redirect_uri = self._error_redirect(error)
            if redirect_uri and not allow:
                logger.info(
                    "OAuth consent denied: user=%s client_id=%s",
                    request.user.get_username(), creds.get("client_id"),
                )
                return Response({"redirect_uri": redirect_uri, "allowed": False})
            return self._error(error)

        logger.info(
            "OAuth consent granted: user=%s client_id=%s scopes=%s",
            request.user.get_username(),
            creds.get("client_id"),
            " ".join(scopes),
        )
        return Response({"redirect_uri": uri, "allowed": allow})

    @staticmethod
    def _error_redirect(error) -> str | None:
        """Build the error redirect for a non-fatal OAuth error, mirroring
        ``OAuthLibMixin.error_response``. Returns ``None`` when the client must
        not be redirected to."""
        if isinstance(error, FatalClientError):
            return None
        oauthlib_error = getattr(error, "oauthlib_error", None)
        redirect_uri = getattr(oauthlib_error, "redirect_uri", None)
        if not redirect_uri:
            return None
        separator = "&" if "?" in redirect_uri else "?"
        return f"{redirect_uri}{separator}{oauthlib_error.urlencoded}"

    @staticmethod
    def _error(error):
        oauthlib_error = getattr(error, "oauthlib_error", None)
        return Response(
            {
                "error": getattr(oauthlib_error, "error", "invalid_request"),
                "error_description": (
                    getattr(oauthlib_error, "description", None) or str(error)
                ),
            },
            status=status.HTTP_400_BAD_REQUEST,
        )


class OAuthConnectionViewSet(viewsets.ViewSet):
    """The requesting user's OAuth connections, one row per client application.

    A single client can hold several access tokens (each refresh mints a new
    one), so rows are grouped by application — the user thinks in terms of
    "claude.ai is connected", not "I have 7 tokens".
    """

    def list(self, request):
        now = timezone.now()
        grouped = (
            AccessToken.objects.filter(user=request.user, expires__gt=now)
            .values("application", "application__name", "application__client_id")
            .annotate(
                token_count=Count("id"),
                first_authorized_at=Min("created"),
                last_authorized_at=Max("created"),
            )
            .order_by("-last_authorized_at")
        )

        rows = []
        for row in grouped:
            # Union the scopes across live tokens: what this client can do right
            # now is the union of what it currently holds.
            scopes: set[str] = set()
            for scope_str in AccessToken.objects.filter(
                user=request.user, application=row["application"], expires__gt=now
            ).values_list("scope", flat=True):
                scopes.update((scope_str or "").split())
            rows.append({
                "application_id": row["application"],
                "name": row["application__name"],
                "client_id": row["application__client_id"],
                "scopes": sorted(scopes),
                "token_count": row["token_count"],
                "first_authorized_at": row["first_authorized_at"],
                "last_authorized_at": row["last_authorized_at"],
            })
        return Response({"results": rows})

    def destroy(self, request, pk=None):
        """Revoke everything this user holds for one application.

        All three token types must go: leaving the refresh token alive would let
        the client mint a fresh access token seconds later, and a live grant
        would let it complete an in-flight code exchange.
        """
        access = AccessToken.objects.filter(user=request.user, application_id=pk)
        refresh = RefreshToken.objects.filter(user=request.user, application_id=pk)
        grants = Grant.objects.filter(user=request.user, application_id=pk)

        counts = {
            "access_tokens": access.count(),
            "refresh_tokens": refresh.count(),
            "grants": grants.count(),
        }
        if not any(counts.values()):
            return Response(
                {"detail": "No connection found for that application."},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Order matters: RefreshToken has a FK to AccessToken, so clear the
        # refresh rows first to avoid tripping the constraint.
        refresh.delete()
        grants.delete()
        access.delete()

        logger.info(
            "OAuth connection revoked: user=%s application=%s %s",
            request.user.get_username(), pk, counts,
        )
        return Response({"revoked": counts})


class McpAccessTokenViewSet(viewsets.ModelViewSet):
    """Personal access tokens for headless MCP clients.

    Reveal-once on create, mirroring ``WebhookEndpointViewSet``: the plaintext
    exists only in the create response, and only its SHA-256 is stored.
    """

    http_method_names = ["get", "post", "delete"]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return McpAccessToken.objects.none()
        return McpAccessToken.objects.filter(
            user=self.request.user, revoked_at__isnull=True
        )

    def get_serializer_class(self):
        if self.action == "create":
            return McpAccessTokenCreateSerializer
        return McpAccessTokenSerializer

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        plaintext, prefix, token_hash = generate_mcp_token()
        token = serializer.save(
            user=request.user, token_prefix=prefix, token_hash=token_hash
        )

        logger.info(
            "MCP personal access token created: user=%s name=%r prefix=%s",
            request.user.get_username(), token.name, prefix,
        )
        body = McpAccessTokenCreatedSerializer(token).data
        body["token"] = plaintext  # the one and only time it is returned
        return Response(body, status=status.HTTP_201_CREATED)

    def perform_destroy(self, instance):
        # Soft-revoke rather than delete, so `last_used_at` stays available as
        # an audit trail for a token that turned out to be compromised.
        instance.revoke()
        logger.info(
            "MCP personal access token revoked: user=%s prefix=%s",
            instance.user.get_username(), instance.token_prefix,
        )
