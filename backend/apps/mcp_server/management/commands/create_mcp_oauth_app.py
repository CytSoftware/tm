"""Management command to create (or display) the default OAuth2 application
for MCP clients.

Usage::

    python manage.py create_mcp_oauth_app

If the application already exists it prints the existing credentials.
The client secret is only shown in plaintext on first creation; after that
the hashed version is stored and the secret cannot be recovered. Re-run with
``--regenerate`` to create a new secret.
"""

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from oauth2_provider.generators import generate_client_secret
from oauth2_provider.models import Application

User = get_user_model()

APP_NAME = "MCP Client"


class Command(BaseCommand):
    help = "Create (or show) the default OAuth2 application for MCP clients."

    def add_arguments(self, parser):
        parser.add_argument(
            "--regenerate",
            action="store_true",
            help="Regenerate the client secret for an existing application.",
        )

    def handle(self, *args, **options):
        app = Application.objects.filter(name=APP_NAME).first()
        plain_secret = None

        if app is not None and not options["regenerate"]:
            self.stdout.write(
                self.style.SUCCESS(f"OAuth application '{APP_NAME}' already exists.\n")
            )
            self.stdout.write(
                "  (Client secret is hashed and cannot be displayed. "
                "Use --regenerate to create a new one.)\n"
            )
        elif app is not None and options["regenerate"]:
            plain_secret = generate_client_secret()
            app.client_secret = plain_secret
            app.save(update_fields=["client_secret"])
            self.stdout.write(
                self.style.SUCCESS(f"Regenerated secret for '{APP_NAME}'.\n")
            )
        else:
            # Find a superuser to own the application
            owner = (
                User.objects.filter(is_superuser=True, is_active=True)
                .order_by("id")
                .first()
            )
            if owner is None:
                self.stderr.write(
                    self.style.ERROR(
                        "No superuser found. Create one first with: "
                        "python manage.py createsuperuser"
                    )
                )
                return

            plain_secret = generate_client_secret()
            app = Application(
                name=APP_NAME,
                user=owner,
                client_type=Application.CLIENT_CONFIDENTIAL,
                authorization_grant_type=Application.GRANT_AUTHORIZATION_CODE,
                redirect_uris="http://localhost",
            )
            # Set the secret directly so we can capture it before hashing
            app.client_secret = plain_secret
            app.save()
            self.stdout.write(
                self.style.SUCCESS(f"Created OAuth application '{APP_NAME}'.\n")
            )

        self.stdout.write(f"  Client ID:     {app.client_id}")
        if plain_secret:
            self.stdout.write(f"  Client Secret: {plain_secret}")
            self.stdout.write(
                self.style.WARNING(
                    "\n  ** Save this secret now -- it cannot be shown again. **\n"
                )
            )
        self.stdout.write(f"  Redirect URIs: {app.redirect_uris}")
        self.stdout.write(f"  Grant Type:    {app.authorization_grant_type}")
        self.stdout.write("")
        self.stdout.write("Configure your MCP client with these credentials.")
        self.stdout.write("OAuth endpoints:")
        self.stdout.write("  Authorize: /oauth/authorize/")
        self.stdout.write("  Token:     /oauth/token/")
