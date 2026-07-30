"""Tests for MCP authentication and the OAuth connect flow.

This is the first Django test suite in the repo, and it starts here on purpose:
every defect these tests pin down shipped to production once already, and the
OAuth path had no coverage at all.

Run with::

    uv run python manage.py test apps.mcp_server
"""

from __future__ import annotations

import base64
import hashlib
import json
from datetime import timedelta
from types import SimpleNamespace
from urllib.parse import parse_qs, urlencode, urlsplit

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import check_password
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone
from oauth2_provider.models import (
    get_access_token_model,
    get_application_model,
    get_grant_model,
    get_refresh_token_model,
)

from .auth import _authenticate_sync
from .models import McpAccessToken, generate_mcp_token

User = get_user_model()
Application = get_application_model()
AccessToken = get_access_token_model()
RefreshToken = get_refresh_token_model()
Grant = get_grant_model()

FRONTEND = "http://localhost:3000"


def pkce_pair() -> tuple[str, str]:
    """Return ``(verifier, S256 challenge)``."""
    verifier = "a" * 64
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


def fake_request_ctx(scope: dict):
    """Install a fake per-message request, as the MCP SDK would.

    Returns the token to pass back to ``request_ctx.reset``.
    """
    from mcp.server.lowlevel.server import request_ctx

    return request_ctx.set(SimpleNamespace(request=SimpleNamespace(scope=scope)))


def reset_request_ctx(token):
    from mcp.server.lowlevel.server import request_ctx

    request_ctx.reset(token)


class DiscoveryMetadataTests(TestCase):
    """RFC 8414 / RFC 9728 documents must name *this* deployment."""

    def test_metadata_is_host_derived_not_hardcoded(self):
        res = self.client.get("/.well-known/oauth-authorization-server")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        # testserver is not a loopback host, so it is HTTPS-forced (see
        # test_non_local_host_is_forced_to_https).
        self.assertEqual(body["issuer"], "https://testserver")
        self.assertEqual(
            body["authorization_endpoint"], "https://testserver/oauth/authorize/"
        )
        self.assertNotIn("tm-api.cytsoftware.com", json.dumps(body))

    @override_settings(BACKEND_PUBLIC_URL="https://tm-api.example.com")
    def test_backend_public_url_wins(self):
        body = self.client.get("/.well-known/oauth-authorization-server").json()
        self.assertEqual(body["issuer"], "https://tm-api.example.com")

    def test_non_local_host_is_forced_to_https(self):
        """Traefik terminates TLS, so an internal http request is still public https."""
        body = self.client.get(
            "/.well-known/oauth-authorization-server",
            headers={"host": "tm-api.example.com"},
        ).json()
        self.assertTrue(body["issuer"].startswith("https://"), body["issuer"])

    def test_localhost_stays_http(self):
        body = self.client.get(
            "/.well-known/oauth-authorization-server",
            headers={"host": "localhost:8000"},
        ).json()
        self.assertEqual(body["issuer"], "http://localhost:8000")

    def test_only_s256_is_advertised(self):
        """PKCE_REQUIRED rejects `plain`, so advertising it misleads clients."""
        body = self.client.get("/.well-known/oauth-authorization-server").json()
        self.assertEqual(body["code_challenge_methods_supported"], ["S256"])

    def test_protected_resource_metadata(self):
        body = self.client.get("/.well-known/oauth-protected-resource").json()
        self.assertEqual(body["resource"], "https://testserver/mcp")
        self.assertEqual(body["authorization_servers"], ["https://testserver"])

    def test_discovery_path_variants_all_resolve(self):
        """Clients differ on trailing slashes and the RFC 8414 /mcp suffix."""
        for path in (
            "/.well-known/oauth-authorization-server",
            "/.well-known/oauth-authorization-server/",
            "/.well-known/oauth-authorization-server/mcp",
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-protected-resource/",
            "/.well-known/oauth-protected-resource/mcp",
            "/.well-known/oauth-protected-resource/mcp/",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)


class DroppedOAuthUrlTests(TestCase):
    """We mount only DOT's base_urlpatterns; make sure nothing depends on the rest."""

    def test_management_views_are_not_exposed(self):
        """They duplicate /settings/connections and render unstyled templates."""
        for path in (
            "/oauth/applications/",
            "/oauth/applications/register/",
            "/oauth/authorized_tokens/",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)

    def test_core_oauth_endpoints_are_exposed(self):
        # Any status but 404 proves the route is mounted; these reject an empty
        # request on their own terms (405 for GET, 400 for a bodyless POST).
        self.assertEqual(self.client.get("/oauth/token/").status_code, 405)
        self.assertNotEqual(self.client.post("/oauth/revoke_token/").status_code, 404)
        self.assertNotEqual(self.client.post("/oauth/introspect/").status_code, 404)

    def test_application_admin_does_not_reverse_a_dropped_route(self):
        """`Application.get_absolute_url` reverses `oauth2_provider:detail`.

        That route is deliberately unmounted, and the admin change form calls
        this to build its "View on site" link — hence `view_on_site = False` in
        `admin.py`. Without it the change page 500s with NoReverseMatch.
        """
        from django.contrib import admin as django_admin

        model_admin = django_admin.site._registry[Application]
        self.assertFalse(model_admin.view_on_site)


class DynamicClientRegistrationTests(TestCase):
    def setUp(self):
        cache.clear()

    def register(self, **body):
        body.setdefault("client_name", "Test Client")
        body.setdefault("redirect_uris", ["https://claude.ai/api/mcp/auth_callback"])
        return self.client.post(
            "/oauth/register/", data=json.dumps(body), content_type="application/json"
        )

    def test_registers_confidential_client_and_returns_usable_secret(self):
        res = self.register()
        self.assertEqual(res.status_code, 201)
        body = res.json()
        app = Application.objects.get(client_id=body["client_id"])
        # The stored value is a hash; the response must carry the plaintext, or
        # the token exchange fails with an opaque "authorization failed".
        # This is the exact bug fixed by 6837528.
        self.assertNotEqual(body["client_secret"], app.client_secret)
        self.assertTrue(check_password(body["client_secret"], app.client_secret))

    def test_registration_does_not_imply_consent(self):
        res = self.register()
        app = Application.objects.get(client_id=res.json()["client_id"])
        self.assertFalse(app.skip_authorization)

    def test_public_client_reregistration_is_deduped(self):
        """A reconnect must not accumulate Application rows."""
        first = self.register(token_endpoint_auth_method="none")
        second = self.register(token_endpoint_auth_method="none")
        self.assertEqual(first.json()["client_id"], second.json()["client_id"])
        self.assertEqual(Application.objects.count(), 1)
        self.assertNotIn("client_secret", second.json())

    def test_confidential_client_is_not_deduped(self):
        """The stored secret is unrecoverable, so an existing row is unusable."""
        first = self.register()
        second = self.register()
        self.assertNotEqual(first.json()["client_id"], second.json()["client_id"])
        self.assertEqual(Application.objects.count(), 2)

    def test_loopback_http_redirect_is_allowed(self):
        """Every CLI client receives its code on a loopback http listener."""
        res = self.register(redirect_uris=["http://127.0.0.1:52045/callback"])
        self.assertEqual(res.status_code, 201, res.content)

    def test_custom_scheme_redirect_is_allowed(self):
        res = self.register(redirect_uris=["cursor://anysphere.cursor-retrieval/oauth"])
        self.assertEqual(res.status_code, 201, res.content)

    def test_non_loopback_http_redirect_is_rejected(self):
        res = self.register(redirect_uris=["http://evil.example.com/cb"])
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["error"], "invalid_redirect_uri")

    def test_unknown_scheme_is_rejected(self):
        res = self.register(redirect_uris=["javascript:alert(1)"])
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["error"], "invalid_redirect_uri")

    def test_missing_redirect_uris_is_rejected(self):
        res = self.register(redirect_uris=[])
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["error"], "invalid_redirect_uri")

    def test_get_is_rejected(self):
        self.assertEqual(self.client.get("/oauth/register/").status_code, 405)

    def test_rate_limited(self):
        for _ in range(10):
            self.assertEqual(self.register().status_code, 201)
        self.assertEqual(self.register().status_code, 429)


@override_settings(FRONTEND_URL=FRONTEND, LOGIN_URL=f"{FRONTEND}/login")
class AuthorizeHandoffTests(TestCase):
    """The redirect chain that used to dead-end on a Next.js 404."""

    def setUp(self):
        self.user = User.objects.create_user("chris", password="pw")
        self.app = Application.objects.create(
            name="claude.ai",
            client_id="test-client",
            client_type=Application.CLIENT_PUBLIC,
            authorization_grant_type=Application.GRANT_AUTHORIZATION_CODE,
            redirect_uris="https://claude.ai/api/mcp/auth_callback",
            skip_authorization=False,
        )
        self.verifier, self.challenge = pkce_pair()

    def authorize_query(self, **extra):
        params = {
            "response_type": "code",
            "client_id": self.app.client_id,
            "redirect_uri": "https://claude.ai/api/mcp/auth_callback",
            "scope": "read write",
            "state": "xyz",
            "code_challenge": self.challenge,
            "code_challenge_method": "S256",
        }
        params.update(extra)
        return urlencode(params)

    def test_anonymous_is_sent_to_frontend_login_with_absolute_next(self):
        """The core bug: a relative `next` resolves against the frontend origin.

        Django's default sends ``next=/oauth/authorize/?…``; the frontend then
        navigates to ``<frontend>/oauth/authorize/…``, which does not exist.
        """
        res = self.client.get(f"/oauth/authorize/?{self.authorize_query()}")
        self.assertEqual(res.status_code, 302)
        self.assertTrue(
            res["Location"].startswith(f"{FRONTEND}/login"), res["Location"]
        )

        next_url = parse_qs(urlsplit(res["Location"]).query)["next"][0]
        parsed = urlsplit(next_url)
        self.assertTrue(
            parsed.scheme and parsed.netloc, f"`next` is relative: {next_url}"
        )
        self.assertEqual(parsed.path, "/oauth/authorize/")
        # The original request must survive the round trip intact.
        self.assertEqual(parse_qs(parsed.query)["code_challenge"], [self.challenge])
        self.assertEqual(parse_qs(parsed.query)["state"], ["xyz"])

    def test_authenticated_first_connect_lands_on_branded_consent(self):
        self.client.force_login(self.user)
        res = self.client.get(f"/oauth/authorize/?{self.authorize_query()}")
        self.assertEqual(res.status_code, 302)
        self.assertTrue(
            res["Location"].startswith(f"{FRONTEND}/oauth/consent"), res["Location"]
        )
        # Parameters forwarded verbatim so the consent page can re-validate.
        query = parse_qs(urlsplit(res["Location"]).query)
        self.assertEqual(query["client_id"], [self.app.client_id])
        self.assertEqual(query["code_challenge"], [self.challenge])

    def test_reconnect_with_live_token_is_silent(self):
        """REQUEST_APPROVAL_PROMPT="auto" — this is what makes it seamless."""
        self.client.force_login(self.user)
        AccessToken.objects.create(
            user=self.user,
            application=self.app,
            token="live-token",
            scope="read write",
            expires=timezone.now() + timedelta(hours=1),
        )
        res = self.client.get(f"/oauth/authorize/?{self.authorize_query()}")
        self.assertEqual(res.status_code, 302)
        self.assertTrue(
            res["Location"].startswith("https://claude.ai/api/mcp/auth_callback"),
            res["Location"],
        )
        self.assertIn("code=", res["Location"])
        self.assertNotIn("/oauth/consent", res["Location"])

    def test_prompt_none_still_returns_login_required_to_the_client(self):
        """OIDC 3.1.2.6: prompt=none must not show UI."""
        res = self.client.get(
            f"/oauth/authorize/?{self.authorize_query(prompt='none')}"
        )
        self.assertEqual(res.status_code, 302)
        self.assertIn("error=login_required", res["Location"])

    def test_invalid_client_is_reported_on_the_consent_page(self):
        self.client.force_login(self.user)
        res = self.client.get(
            f"/oauth/authorize/?{self.authorize_query(client_id='nope')}"
        )
        self.assertEqual(res.status_code, 302)
        self.assertIn("/oauth/consent", res["Location"])
        self.assertIn("error=", res["Location"])


@override_settings(FRONTEND_URL=FRONTEND, LOGIN_URL=f"{FRONTEND}/login")
class ConsentApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user("chris", password="pw", email="c@x.io")
        self.app = Application.objects.create(
            name="claude.ai",
            client_id="test-client",
            client_type=Application.CLIENT_PUBLIC,
            authorization_grant_type=Application.GRANT_AUTHORIZATION_CODE,
            redirect_uris="https://claude.ai/api/mcp/auth_callback",
        )
        self.verifier, self.challenge = pkce_pair()
        self.query = urlencode({
            "response_type": "code",
            "client_id": self.app.client_id,
            "redirect_uri": "https://claude.ai/api/mcp/auth_callback",
            "scope": "read write",
            "state": "xyz",
            "code_challenge": self.challenge,
            "code_challenge_method": "S256",
        })
        self.url = f"/api/oauth/authorize-request/?{self.query}"

    def test_requires_authentication(self):
        self.assertIn(self.client.get(self.url).status_code, (401, 403))

    def test_describes_the_pending_request(self):
        self.client.force_login(self.user)
        body = self.client.get(self.url).json()
        self.assertEqual(body["client_name"], "claude.ai")
        self.assertEqual([s["name"] for s in body["scopes"]], ["read", "write"])
        # Descriptions come from OAUTH2_PROVIDER["SCOPES"] — the consent screen
        # shows these, so they must be human sentences, not scope keys.
        self.assertNotEqual(body["scopes"][0]["description"], "read")
        self.assertEqual(body["account"]["username"], "chris")
        self.assertFalse(body["previously_authorized"])

    def test_allow_returns_a_code(self):
        self.client.force_login(self.user)
        res = self.client.post(
            self.url, data=json.dumps({"allow": True}), content_type="application/json"
        )
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertTrue(body["allowed"])
        query = parse_qs(urlsplit(body["redirect_uri"]).query)
        self.assertIn("code", query)
        self.assertEqual(query["state"], ["xyz"])
        self.assertTrue(Grant.objects.filter(user=self.user).exists())

    def test_deny_returns_access_denied_rather_than_hanging(self):
        self.client.force_login(self.user)
        res = self.client.post(
            self.url, data=json.dumps({"allow": False}), content_type="application/json"
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertFalse(body["allowed"])
        self.assertIn("error=access_denied", body["redirect_uri"])
        self.assertFalse(Grant.objects.exists())

    def test_pkce_challenge_is_carried_onto_the_grant(self):
        """Dropping code_challenge would silently disable PKCE."""
        self.client.force_login(self.user)
        self.client.post(
            self.url, data=json.dumps({"allow": True}), content_type="application/json"
        )
        grant = Grant.objects.get(user=self.user)
        self.assertEqual(grant.code_challenge, self.challenge)
        self.assertEqual(grant.code_challenge_method, "S256")

    def test_bad_request_is_reported_as_json_not_a_redirect(self):
        self.client.force_login(self.user)
        res = self.client.get("/api/oauth/authorize-request/?client_id=nope")
        self.assertEqual(res.status_code, 400)
        self.assertIn("error", res.json())


@override_settings(FRONTEND_URL=FRONTEND, LOGIN_URL=f"{FRONTEND}/login")
class EndToEndConnectTests(TestCase):
    """The whole flow a client actually walks, with nothing stubbed.

    Discovery → dynamic registration → authorize → consent → token exchange →
    authenticated MCP call. Worth having as one test because every previous
    OAuth regression was a seam *between* these steps: the plaintext secret
    (6837528), the login redirect, the missing discovery hint (2dfa4e8).
    """

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user("chris", password="pw")

    def test_public_client_completes_the_whole_flow(self):
        verifier, challenge = pkce_pair()

        # 1. Discover.
        meta = self.client.get("/.well-known/oauth-authorization-server").json()
        self.assertIn("registration_endpoint", meta)

        # 2. Register dynamically, as claude.ai does (public client + PKCE).
        registration = self.client.post(
            "/oauth/register/",
            data=json.dumps({
                "client_name": "claude.ai",
                "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
                "token_endpoint_auth_method": "none",
            }),
            content_type="application/json",
        )
        self.assertEqual(registration.status_code, 201)
        client_id = registration.json()["client_id"]

        # 3. Authorize while logged in → consent hand-off.
        self.client.force_login(self.user)
        query = urlencode({
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": "https://claude.ai/api/mcp/auth_callback",
            "scope": "read write",
            "state": "st8",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            # RFC 8707. django-oauth-toolkit 3.2 doesn't model this, but a
            # spec-compliant MCP client sends it and it must not break anything.
            "resource": "https://testserver/mcp",
        })
        authorize = self.client.get(f"/oauth/authorize/?{query}")
        self.assertEqual(authorize.status_code, 302)
        self.assertIn(f"{FRONTEND}/oauth/consent", authorize["Location"])

        # 4. Consent: the page forwards the query string it was handed.
        consent_query = urlsplit(authorize["Location"]).query
        decision = self.client.post(
            f"/api/oauth/authorize-request/?{consent_query}",
            data=json.dumps({"allow": True}),
            content_type="application/json",
        )
        self.assertEqual(decision.status_code, 200, decision.content)
        code = parse_qs(urlsplit(decision.json()["redirect_uri"]).query)["code"][0]

        # 5. Exchange the code. A public client sends no secret, only the
        #    verifier — this is the step that used to fail opaquely.
        token_res = self.client.post("/oauth/token/", data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": "https://claude.ai/api/mcp/auth_callback",
            "client_id": client_id,
            "code_verifier": verifier,
        })
        self.assertEqual(token_res.status_code, 200, token_res.content)
        payload = token_res.json()
        self.assertEqual(payload["token_type"], "Bearer")
        self.assertIn("refresh_token", payload)

        # 6. The token authenticates against /mcp *as this user*, which is the
        #    entire point — writes are attributed rather than landing on
        #    "first superuser".
        auth = _authenticate_sync(f"Bearer {payload['access_token']}")
        self.assertIsNotNone(auth)
        self.assertEqual(auth.kind, "oauth")
        self.assertEqual(auth.user, self.user)
        self.assertEqual(sorted(auth.scopes), ["read", "write"])

        # 7. Reconnecting is now silent — no second consent screen.
        again = self.client.get(f"/oauth/authorize/?{query}")
        self.assertEqual(again.status_code, 302)
        self.assertTrue(
            again["Location"].startswith("https://claude.ai/api/mcp/auth_callback")
        )

        # 8. And it shows up as a revocable connection.
        rows = self.client.get("/api/oauth/connections/").json()["results"]
        self.assertEqual([r["name"] for r in rows], ["claude.ai"])
        self.client.delete(f"/api/oauth/connections/{rows[0]['application_id']}/")
        self.assertIsNone(_authenticate_sync(f"Bearer {payload['access_token']}"))

    def test_wrong_pkce_verifier_is_rejected(self):
        """PKCE must actually be enforced, not merely advertised."""
        _verifier, challenge = pkce_pair()
        app = Application.objects.create(
            name="cli",
            client_id="cli-client",
            client_type=Application.CLIENT_PUBLIC,
            authorization_grant_type=Application.GRANT_AUTHORIZATION_CODE,
            redirect_uris="http://127.0.0.1:9999/callback",
        )
        self.client.force_login(self.user)
        query = urlencode({
            "response_type": "code",
            "client_id": app.client_id,
            "redirect_uri": "http://127.0.0.1:9999/callback",
            "scope": "read write",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        })
        decision = self.client.post(
            f"/api/oauth/authorize-request/?{query}",
            data=json.dumps({"allow": True}),
            content_type="application/json",
        )
        code = parse_qs(urlsplit(decision.json()["redirect_uri"]).query)["code"][0]

        token_res = self.client.post("/oauth/token/", data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": "http://127.0.0.1:9999/callback",
            "client_id": app.client_id,
            "code_verifier": "b" * 64,  # wrong
        })
        self.assertEqual(token_res.status_code, 400)


class McpGateTests(TestCase):
    """`apps.mcp_server.auth` — the single gate in front of /mcp."""

    def setUp(self):
        self.user = User.objects.create_user("chris", password="pw")
        self.app = Application.objects.create(
            name="claude.ai",
            client_id="c",
            client_type=Application.CLIENT_PUBLIC,
            authorization_grant_type=Application.GRANT_AUTHORIZATION_CODE,
            redirect_uris="https://claude.ai/cb",
        )

    def make_oauth_token(self, *, scope="read write", expires_in=3600):
        return AccessToken.objects.create(
            user=self.user,
            application=self.app,
            token="tok-abc",
            scope=scope,
            expires=timezone.now() + timedelta(seconds=expires_in),
        )

    # --- OAuth ---------------------------------------------------------------

    def test_valid_oauth_token_identifies_the_user(self):
        self.make_oauth_token()
        auth = _authenticate_sync("Bearer tok-abc")
        self.assertIsNotNone(auth)
        self.assertEqual(auth.kind, "oauth")
        self.assertEqual(auth.user, self.user)
        self.assertEqual(sorted(auth.scopes), ["read", "write"])

    def test_expired_oauth_token_is_rejected(self):
        self.make_oauth_token(expires_in=-1)
        self.assertIsNone(_authenticate_sync("Bearer tok-abc"))

    def test_oauth_token_without_required_scope_is_rejected(self):
        """The old gate checked expiry only, so scope was unenforced."""
        self.make_oauth_token(scope="openid")
        self.assertIsNone(_authenticate_sync("Bearer tok-abc"))

    def test_read_only_oauth_token_may_connect(self):
        self.make_oauth_token(scope="read")
        auth = _authenticate_sync("Bearer tok-abc")
        self.assertIsNotNone(auth)
        self.assertEqual(auth.scopes, ["read"])

    def test_revoked_oauth_token_is_rejected(self):
        token = self.make_oauth_token()
        token.delete()  # how django-oauth-toolkit revokes
        self.assertIsNone(_authenticate_sync("Bearer tok-abc"))

    def test_bearer_scheme_is_case_insensitive(self):
        """RFC 6750 §2.1 — the old gate required the literal "Bearer "."""
        self.make_oauth_token()
        self.assertIsNotNone(_authenticate_sync("bearer tok-abc"))

    def test_unknown_token_is_rejected(self):
        self.assertIsNone(_authenticate_sync("Bearer nonsense"))

    # --- Personal access tokens ---------------------------------------------

    def make_pat(self, **kwargs):
        plaintext, prefix, token_hash = generate_mcp_token()
        kwargs.setdefault("scopes", ["read", "write"])
        kwargs.setdefault("name", "Claude Code")
        token = McpAccessToken.objects.create(
            user=self.user, token_prefix=prefix, token_hash=token_hash, **kwargs
        )
        return plaintext, token

    def test_personal_token_identifies_the_user(self):
        plaintext, _ = self.make_pat()
        auth = _authenticate_sync(f"Bearer {plaintext}")
        self.assertIsNotNone(auth)
        self.assertEqual(auth.kind, "pat")
        self.assertEqual(auth.user, self.user)

    def test_plaintext_is_never_stored(self):
        plaintext, token = self.make_pat()
        self.assertNotIn(plaintext, token.token_hash)
        self.assertNotIn(plaintext, token.token_prefix)
        self.assertEqual(
            token.token_hash, hashlib.sha256(plaintext.encode()).hexdigest()
        )

    def test_revoked_personal_token_is_rejected(self):
        plaintext, token = self.make_pat()
        token.revoke()
        self.assertIsNone(_authenticate_sync(f"Bearer {plaintext}"))

    def test_expired_personal_token_is_rejected(self):
        plaintext, _ = self.make_pat(
            expires_at=timezone.now() - timedelta(minutes=1)
        )
        self.assertIsNone(_authenticate_sync(f"Bearer {plaintext}"))

    def test_personal_token_without_required_scope_is_rejected(self):
        plaintext, _ = self.make_pat(scopes=[])
        self.assertIsNone(_authenticate_sync(f"Bearer {plaintext}"))

    def test_personal_token_of_inactive_user_is_rejected(self):
        plaintext, _ = self.make_pat()
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        self.assertIsNone(_authenticate_sync(f"Bearer {plaintext}"))

    def test_use_is_recorded(self):
        plaintext, token = self.make_pat()
        _authenticate_sync(f"Bearer {plaintext}")
        token.refresh_from_db()
        self.assertIsNotNone(token.last_used_at)

    # --- Static token / anonymous -------------------------------------------

    @override_settings(CYT_MCP_TOKEN="legacy-secret", MCP_ALLOW_ANONYMOUS=False)
    def test_static_token_still_works_but_names_no_user(self):
        auth = _authenticate_sync("Bearer legacy-secret")
        self.assertIsNotNone(auth)
        self.assertEqual(auth.kind, "static")
        self.assertIsNone(auth.user)

    @override_settings(CYT_MCP_TOKEN="", MCP_ALLOW_ANONYMOUS=False)
    def test_missing_header_is_rejected_when_anonymous_is_off(self):
        """Previously an empty CYT_MCP_TOKEN left /mcp wide open in production."""
        self.assertIsNone(_authenticate_sync(""))

    @override_settings(CYT_MCP_TOKEN="", MCP_ALLOW_ANONYMOUS=True)
    def test_missing_header_is_allowed_in_local_dev(self):
        auth = _authenticate_sync("")
        self.assertIsNotNone(auth)
        self.assertEqual(auth.kind, "anonymous")

    @override_settings(CYT_MCP_TOKEN="legacy-secret", MCP_ALLOW_ANONYMOUS=False)
    def test_wrong_static_token_is_rejected(self):
        self.assertIsNone(_authenticate_sync("Bearer not-the-secret"))

    @override_settings(MCP_ALLOW_ANONYMOUS=False)
    def test_non_bearer_scheme_is_rejected(self):
        self.assertIsNone(_authenticate_sync("Basic dXNlcjpwYXNz"))


class PerRequestAttributionTests(TestCase):
    """The scope dict, not the module ContextVar, is the source of truth.

    Over streamable HTTP the session manager spawns one task per session and
    anyio copies the context at session-creation time, so a ContextVar set in
    the ASGI coroutine is pinned to whoever *opened* the session — every later
    call on it would be attributed to them.
    """

    def setUp(self):
        self.alice = User.objects.create_user("alice")
        self.bob = User.objects.create_user("bob")

    def test_scope_user_wins_over_the_contextvar(self):
        from core.asgi import mcp_authenticated_user

        from .auth import SCOPE_USER_KEY
        from .server import _get_mcp_user

        # The ContextVar holds the session opener; the current message is Bob's.
        cv_token = mcp_authenticated_user.set(self.alice)
        ctx_token = fake_request_ctx({SCOPE_USER_KEY: self.bob})
        try:
            self.assertEqual(_get_mcp_user(), self.bob)
        finally:
            reset_request_ctx(ctx_token)
            mcp_authenticated_user.reset(cv_token)

    def test_falls_back_to_contextvar_for_stdio(self):
        from core.asgi import mcp_authenticated_user

        from .server import _get_mcp_user

        cv_token = mcp_authenticated_user.set(self.alice)
        try:
            # No request_ctx set at all — the stdio transport's situation.
            self.assertEqual(_get_mcp_user(), self.alice)
        finally:
            mcp_authenticated_user.reset(cv_token)

    def test_scopes_are_read_per_request(self):
        from .auth import SCOPE_SCOPES_KEY
        from .server import _get_mcp_scopes

        token = fake_request_ctx({SCOPE_SCOPES_KEY: ["read"]})
        try:
            self.assertEqual(_get_mcp_scopes(), ["read"])
        finally:
            reset_request_ctx(token)


class WriteScopeEnforcementTests(TestCase):
    def setUp(self):
        self._ctx_token = None

    def tearDown(self):
        if self._ctx_token is not None:
            reset_request_ctx(self._ctx_token)
            self._ctx_token = None

    def _set_scopes(self, scopes):
        from .auth import SCOPE_SCOPES_KEY

        self._ctx_token = fake_request_ctx({SCOPE_SCOPES_KEY: scopes})

    def test_read_only_connection_cannot_write(self):
        from .server import _require_write_scope

        self._set_scopes(["read"])
        with self.assertRaises(ValueError) as ctx:
            _require_write_scope("create_task")
        self.assertIn("read-only", str(ctx.exception))

    def test_write_scope_permits_writes(self):
        from .server import _require_write_scope

        self._set_scopes(["read", "write"])
        _require_write_scope("create_task")  # must not raise

    def test_stdio_is_unrestricted(self):
        from .server import _require_write_scope

        _require_write_scope("create_task")  # no request_ctx → no restriction

    def test_read_only_tool_names_all_exist(self):
        """A tool absent from READ_ONLY_TOOLS is write-guarded by default.

        That fail-safe default only works if the list itself stays accurate, so
        a rename must not silently leave a stale entry behind.
        """
        from .server import READ_ONLY_TOOLS, mcp

        registered = set(mcp._tool_manager._tools)
        self.assertTrue(registered, "no tools registered")
        stale = READ_ONLY_TOOLS - registered
        self.assertFalse(stale, f"READ_ONLY_TOOLS names no longer exist: {stale}")


class ConnectionsApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user("chris", password="pw")
        self.other = User.objects.create_user("someone-else", password="pw")
        self.app = Application.objects.create(
            name="claude.ai",
            client_id="c",
            client_type=Application.CLIENT_PUBLIC,
            authorization_grant_type=Application.GRANT_AUTHORIZATION_CODE,
            redirect_uris="https://claude.ai/cb",
        )
        self.client.force_login(self.user)

    def _token(self, user, token="t1"):
        return AccessToken.objects.create(
            user=user,
            application=self.app,
            token=token,
            scope="read write",
            expires=timezone.now() + timedelta(hours=1),
        )

    def test_lists_only_the_callers_connections(self):
        self._token(self.user, "mine")
        self._token(self.other, "theirs")
        rows = self.client.get("/api/oauth/connections/").json()["results"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "claude.ai")
        self.assertEqual(rows[0]["scopes"], ["read", "write"])

    def test_multiple_tokens_collapse_to_one_row(self):
        """A refresh mints a new access token; the user still sees one client."""
        self._token(self.user, "t1")
        self._token(self.user, "t2")
        rows = self.client.get("/api/oauth/connections/").json()["results"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["token_count"], 2)

    def test_revoke_removes_access_refresh_and_grants(self):
        access = self._token(self.user)
        RefreshToken.objects.create(
            user=self.user, application=self.app, token="r1", access_token=access
        )
        Grant.objects.create(
            user=self.user,
            application=self.app,
            code="g1",
            expires=timezone.now() + timedelta(minutes=5),
            redirect_uri="https://claude.ai/cb",
        )
        res = self.client.delete(f"/api/oauth/connections/{self.app.pk}/")
        self.assertEqual(res.status_code, 200)
        # Leaving the refresh token alive would let the client mint a new access
        # token seconds later, making "revoke" a lie.
        self.assertFalse(AccessToken.objects.filter(user=self.user).exists())
        self.assertFalse(RefreshToken.objects.filter(user=self.user).exists())
        self.assertFalse(Grant.objects.filter(user=self.user).exists())

    def test_cannot_revoke_another_users_connection(self):
        self._token(self.other, "theirs")
        res = self.client.delete(f"/api/oauth/connections/{self.app.pk}/")
        self.assertEqual(res.status_code, 404)
        self.assertTrue(AccessToken.objects.filter(user=self.other).exists())

    def test_requires_authentication(self):
        self.client.logout()
        self.assertIn(
            self.client.get("/api/oauth/connections/").status_code, (401, 403)
        )


class PersonalTokenApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user("chris", password="pw")
        self.client.force_login(self.user)

    def create(self, **body):
        body.setdefault("name", "Claude Code")
        return self.client.post(
            "/api/mcp/tokens/", data=json.dumps(body), content_type="application/json"
        )

    @staticmethod
    def _rows(payload):
        return payload["results"] if isinstance(payload, dict) else payload

    def test_create_reveals_the_token_once(self):
        res = self.create()
        self.assertEqual(res.status_code, 201, res.content)
        plaintext = res.json()["token"]
        self.assertTrue(plaintext.startswith("cyt_mcp_"))

        # ...and never again.
        rows = self._rows(self.client.get("/api/mcp/tokens/").json())
        self.assertNotIn("token", rows[0])
        self.assertNotIn(plaintext, json.dumps(rows))

    def test_created_token_authenticates_against_the_mcp_gate(self):
        plaintext = self.create().json()["token"]
        auth = _authenticate_sync(f"Bearer {plaintext}")
        self.assertIsNotNone(auth)
        self.assertEqual(auth.user, self.user)

    def test_defaults_to_full_scopes(self):
        res = self.create()
        self.assertEqual(sorted(res.json()["scopes"]), ["read", "write"])

    def test_read_only_token_can_be_minted(self):
        res = self.create(scopes=["read"])
        self.assertEqual(res.json()["scopes"], ["read"])

    def test_unknown_scope_is_rejected(self):
        self.assertEqual(self.create(scopes=["admin"]).status_code, 400)

    def test_past_expiry_is_rejected(self):
        past = (timezone.now() - timedelta(days=1)).isoformat()
        self.assertEqual(self.create(expires_at=past).status_code, 400)

    def test_blank_name_is_rejected(self):
        self.assertEqual(self.create(name="   ").status_code, 400)

    def test_revoke_stops_authentication(self):
        created = self.create().json()
        plaintext = created["token"]
        res = self.client.delete(f"/api/mcp/tokens/{created['id']}/")
        self.assertEqual(res.status_code, 204)
        self.assertIsNone(_authenticate_sync(f"Bearer {plaintext}"))

    def test_revoked_tokens_are_hidden_but_retained_for_audit(self):
        created = self.create().json()
        self.client.delete(f"/api/mcp/tokens/{created['id']}/")
        rows = self._rows(self.client.get("/api/mcp/tokens/").json())
        self.assertEqual(rows, [])
        self.assertTrue(McpAccessToken.objects.filter(pk=created["id"]).exists())

    def test_cannot_see_or_revoke_another_users_token(self):
        other = User.objects.create_user("other")
        _, prefix, token_hash = generate_mcp_token()
        theirs = McpAccessToken.objects.create(
            user=other,
            name="theirs",
            token_prefix=prefix,
            token_hash=token_hash,
            scopes=["read"],
        )
        self.assertEqual(
            self.client.delete(f"/api/mcp/tokens/{theirs.pk}/").status_code, 404
        )

    def test_requires_authentication(self):
        self.client.logout()
        self.assertIn(self.client.get("/api/mcp/tokens/").status_code, (401, 403))
