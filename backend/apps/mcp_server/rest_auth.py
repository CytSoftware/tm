"""Personal access tokens on selected REST views.

Applied per view, never in ``DEFAULT_AUTHENTICATION_CLASSES``:
``NonStaffAccessMiddleware`` runs before DRF authenticates and only sees the
session user, so a bearer user is invisible to it. Enabling this globally
would let a non-staff token reach every endpoint the middleware is meant to
refuse. The views that opt in must do their own scoping.
"""

from __future__ import annotations

from drf_spectacular.extensions import OpenApiAuthenticationExtension
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed

from .auth import _authenticate_pat, _parse_bearer
from .models import TOKEN_PREFIX


class PatAuthentication(BaseAuthentication):
    """``Authorization: Bearer cyt_mcp_…`` with the ``write`` scope."""

    def authenticate(self, request):
        bearer = _parse_bearer(request.META.get("HTTP_AUTHORIZATION", ""))
        if bearer is None or not bearer.startswith(TOKEN_PREFIX):
            return None
        auth = _authenticate_pat(bearer, ["write"])
        if auth is None:
            raise AuthenticationFailed("Invalid, revoked or read-only token.")
        return (auth.user, auth)

    def authenticate_header(self, request):
        return "Bearer"


class PatAuthenticationScheme(OpenApiAuthenticationExtension):
    target_class = PatAuthentication
    name = "personalAccessToken"

    def get_security_definition(self, auto_schema):
        return {"type": "http", "scheme": "bearer", "description": "cyt_mcp_… with the write scope"}
