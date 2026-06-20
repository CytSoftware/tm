from __future__ import annotations

from django.apps import AppConfig


def _set_sqlite_pragmas(sender, connection, **kwargs):
    """Harden SQLite for the collaborative-wiki write pattern.

    The Yjs collab consumer persists CRDT state frequently while a doc is being
    edited; combined with normal app traffic on one SQLite file that invites
    ``database is locked`` errors. WAL lets readers and a writer coexist, a
    long ``busy_timeout`` makes writers wait instead of erroring, and
    ``synchronous=NORMAL`` is the safe/fast pairing for WAL. These are
    process-wide (every connection) and benefit the whole app, not just wiki.
    """
    if connection.vendor != "sqlite":
        return
    with connection.cursor() as cur:
        cur.execute("PRAGMA journal_mode=WAL;")
        cur.execute("PRAGMA synchronous=NORMAL;")
        cur.execute("PRAGMA busy_timeout=20000;")


class WikiConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.wiki"
    label = "wiki"

    def ready(self):
        from django.db.backends.signals import connection_created

        connection_created.connect(
            _set_sqlite_pragmas, dispatch_uid="wiki_sqlite_pragmas"
        )
