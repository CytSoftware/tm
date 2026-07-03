"""Cyt OS period grid.

Bets belong to fixed two-month periods anchored at **July 1, 2026** (the
first Cyt operating cycle). Periods are pure math — no stored rows, no
generation job:

    period n = [anchor + 2n months, anchor + 2(n+1) months)

for any integer ``n`` (negative n predates the anchor and is still valid).
Any date can be snapped to the start of its containing period with
:func:`period_start_for`; ``Bet.save()`` snaps automatically so callers can
pass an arbitrary date and always land on the grid.
"""

from __future__ import annotations

from datetime import date

from django.utils import timezone

PERIOD_ANCHOR = date(2026, 7, 1)
PERIOD_MONTHS = 2


def _month_index(d: date) -> int:
    """Months since year 0 — turns month arithmetic into integer math."""
    return d.year * 12 + (d.month - 1)


def _from_month_index(idx: int) -> date:
    return date(idx // 12, idx % 12 + 1, 1)


def period_start_for(d: date) -> date:
    """Snap any date to the first day of the period containing it."""
    offset = _month_index(d) - _month_index(PERIOD_ANCHOR)
    # Floor division keeps pre-anchor dates on the same grid.
    start_offset = (offset // PERIOD_MONTHS) * PERIOD_MONTHS
    return _from_month_index(_month_index(PERIOD_ANCHOR) + start_offset)


def current_period_start(today: date | None = None) -> date:
    return period_start_for(today or timezone.localdate())


def period_end(start: date) -> date:
    """Exclusive end of the period starting at ``start`` (= next start)."""
    return _from_month_index(_month_index(start) + PERIOD_MONTHS)


def period_label(start: date) -> str:
    """Human label like ``"Jul–Aug 2026"`` (``"Dec 2026–Jan 2027"`` across years)."""
    last = _from_month_index(_month_index(start) + PERIOD_MONTHS - 1)
    if start.year == last.year:
        return f"{start.strftime('%b')}–{last.strftime('%b')} {start.year}"
    return f"{start.strftime('%b %Y')}–{last.strftime('%b %Y')}"
