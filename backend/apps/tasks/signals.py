"""Signal handlers for the tasks app.

Imported from ``apps.py`` so the handlers register on app startup. Individual
handlers are added in ``models.py`` (default-column creation) and after the
Channels broadcast helper is wired up (post_save/post_delete broadcasts).
"""
