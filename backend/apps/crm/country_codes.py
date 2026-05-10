"""ISO 3166-1 alpha-2 country code normalization.

Used by the CSV importer to coerce free-text country values like ``"USA"``,
``"United States"``, or ``"us"`` into the canonical 2-letter code (``"US"``)
that the ``Contact.country`` column stores.

The lookup is intentionally permissive — falls back to an empty string when
no match is found rather than raising, so a single bad row doesn't kill an
import. The caller can decide what to do with the empty result.
"""

from __future__ import annotations


# Map ISO-2 → list of accepted variants (lowercased, exact match).
# Includes the ISO-2 itself, common ISO-3 codes, and full/common names.
# Not exhaustive for every country, but covers the realistic business set.
_CODE_TO_NAMES: dict[str, list[str]] = {
    "AD": ["ad", "and", "andorra"],
    "AE": ["ae", "are", "uae", "united arab emirates"],
    "AF": ["af", "afg", "afghanistan"],
    "AG": ["ag", "atg", "antigua and barbuda"],
    "AL": ["al", "alb", "albania"],
    "AM": ["am", "arm", "armenia"],
    "AO": ["ao", "ago", "angola"],
    "AR": ["ar", "arg", "argentina"],
    "AT": ["at", "aut", "austria"],
    "AU": ["au", "aus", "australia"],
    "AZ": ["az", "aze", "azerbaijan"],
    "BA": ["ba", "bih", "bosnia", "bosnia and herzegovina", "bosnia & herzegovina"],
    "BB": ["bb", "brb", "barbados"],
    "BD": ["bd", "bgd", "bangladesh"],
    "BE": ["be", "bel", "belgium"],
    "BF": ["bf", "bfa", "burkina faso"],
    "BG": ["bg", "bgr", "bulgaria"],
    "BH": ["bh", "bhr", "bahrain"],
    "BI": ["bi", "bdi", "burundi"],
    "BJ": ["bj", "ben", "benin"],
    "BN": ["bn", "brn", "brunei", "brunei darussalam"],
    "BO": ["bo", "bol", "bolivia"],
    "BR": ["br", "bra", "brazil", "brasil"],
    "BS": ["bs", "bhs", "bahamas"],
    "BT": ["bt", "btn", "bhutan"],
    "BW": ["bw", "bwa", "botswana"],
    "BY": ["by", "blr", "belarus"],
    "BZ": ["bz", "blz", "belize"],
    "CA": ["ca", "can", "canada"],
    "CD": ["cd", "cod", "dr congo", "drc", "democratic republic of congo", "democratic republic of the congo", "congo-kinshasa"],
    "CF": ["cf", "caf", "central african republic", "car"],
    "CG": ["cg", "cog", "republic of congo", "congo", "congo-brazzaville"],
    "CH": ["ch", "che", "switzerland", "swiss"],
    "CI": ["ci", "civ", "ivory coast", "cote d'ivoire", "côte d'ivoire"],
    "CL": ["cl", "chl", "chile"],
    "CM": ["cm", "cmr", "cameroon"],
    "CN": ["cn", "chn", "china", "people's republic of china", "prc"],
    "CO": ["co", "col", "colombia"],
    "CR": ["cr", "cri", "costa rica"],
    "CU": ["cu", "cub", "cuba"],
    "CV": ["cv", "cpv", "cape verde", "cabo verde"],
    "CY": ["cy", "cyp", "cyprus"],
    "CZ": ["cz", "cze", "czech republic", "czechia"],
    "DE": ["de", "deu", "germany", "deutschland"],
    "DJ": ["dj", "dji", "djibouti"],
    "DK": ["dk", "dnk", "denmark"],
    "DO": ["do", "dom", "dominican republic"],
    "DZ": ["dz", "dza", "algeria"],
    "EC": ["ec", "ecu", "ecuador"],
    "EE": ["ee", "est", "estonia"],
    "EG": ["eg", "egy", "egypt"],
    "ER": ["er", "eri", "eritrea"],
    "ES": ["es", "esp", "spain", "españa", "espana"],
    "ET": ["et", "eth", "ethiopia"],
    "FI": ["fi", "fin", "finland"],
    "FJ": ["fj", "fji", "fiji"],
    "FR": ["fr", "fra", "france"],
    "GA": ["ga", "gab", "gabon"],
    "GB": ["gb", "gbr", "uk", "united kingdom", "great britain", "britain", "england"],
    "GE": ["ge", "geo", "georgia"],
    "GH": ["gh", "gha", "ghana"],
    "GM": ["gm", "gmb", "gambia"],
    "GN": ["gn", "gin", "guinea"],
    "GQ": ["gq", "gnq", "equatorial guinea"],
    "GR": ["gr", "grc", "greece"],
    "GT": ["gt", "gtm", "guatemala"],
    "GW": ["gw", "gnb", "guinea-bissau"],
    "GY": ["gy", "guy", "guyana"],
    "HK": ["hk", "hkg", "hong kong"],
    "HN": ["hn", "hnd", "honduras"],
    "HR": ["hr", "hrv", "croatia"],
    "HT": ["ht", "hti", "haiti"],
    "HU": ["hu", "hun", "hungary"],
    "ID": ["id", "idn", "indonesia"],
    "IE": ["ie", "irl", "ireland"],
    "IL": ["il", "isr", "israel"],
    "IN": ["in", "ind", "india"],
    "IQ": ["iq", "irq", "iraq"],
    "IR": ["ir", "irn", "iran"],
    "IS": ["is", "isl", "iceland"],
    "IT": ["it", "ita", "italy", "italia"],
    "JM": ["jm", "jam", "jamaica"],
    "JO": ["jo", "jor", "jordan"],
    "JP": ["jp", "jpn", "japan"],
    "KE": ["ke", "ken", "kenya"],
    "KG": ["kg", "kgz", "kyrgyzstan"],
    "KH": ["kh", "khm", "cambodia"],
    "KR": ["kr", "kor", "south korea", "korea", "republic of korea"],
    "KW": ["kw", "kwt", "kuwait"],
    "KZ": ["kz", "kaz", "kazakhstan"],
    "LA": ["la", "lao", "laos", "lao people's democratic republic"],
    "LB": ["lb", "lbn", "lebanon"],
    "LI": ["li", "lie", "liechtenstein"],
    "LK": ["lk", "lka", "sri lanka"],
    "LR": ["lr", "lbr", "liberia"],
    "LS": ["ls", "lso", "lesotho"],
    "LT": ["lt", "ltu", "lithuania"],
    "LU": ["lu", "lux", "luxembourg"],
    "LV": ["lv", "lva", "latvia"],
    "LY": ["ly", "lby", "libya"],
    "MA": ["ma", "mar", "morocco"],
    "MC": ["mc", "mco", "monaco"],
    "MD": ["md", "mda", "moldova"],
    "ME": ["me", "mne", "montenegro"],
    "MG": ["mg", "mdg", "madagascar"],
    "MK": ["mk", "mkd", "north macedonia", "macedonia"],
    "ML": ["ml", "mli", "mali"],
    "MM": ["mm", "mmr", "myanmar", "burma"],
    "MN": ["mn", "mng", "mongolia"],
    "MO": ["mo", "mac", "macau", "macao"],
    "MR": ["mr", "mrt", "mauritania"],
    "MT": ["mt", "mlt", "malta"],
    "MU": ["mu", "mus", "mauritius"],
    "MV": ["mv", "mdv", "maldives"],
    "MW": ["mw", "mwi", "malawi"],
    "MX": ["mx", "mex", "mexico"],
    "MY": ["my", "mys", "malaysia"],
    "MZ": ["mz", "moz", "mozambique"],
    "NA": ["na", "nam", "namibia"],
    "NE": ["ne", "ner", "niger"],
    "NG": ["ng", "nga", "nigeria"],
    "NI": ["ni", "nic", "nicaragua"],
    "NL": ["nl", "nld", "netherlands", "holland", "the netherlands"],
    "NO": ["no", "nor", "norway"],
    "NP": ["np", "npl", "nepal"],
    "NZ": ["nz", "nzl", "new zealand"],
    "OM": ["om", "omn", "oman"],
    "PA": ["pa", "pan", "panama"],
    "PE": ["pe", "per", "peru"],
    "PG": ["pg", "png", "papua new guinea"],
    "PH": ["ph", "phl", "philippines"],
    "PK": ["pk", "pak", "pakistan"],
    "PL": ["pl", "pol", "poland"],
    "PR": ["pr", "pri", "puerto rico"],
    "PS": ["ps", "pse", "palestine", "state of palestine"],
    "PT": ["pt", "prt", "portugal"],
    "PY": ["py", "pry", "paraguay"],
    "QA": ["qa", "qat", "qatar"],
    "RO": ["ro", "rou", "romania"],
    "RS": ["rs", "srb", "serbia"],
    "RU": ["ru", "rus", "russia", "russian federation"],
    "RW": ["rw", "rwa", "rwanda"],
    "SA": ["sa", "sau", "saudi arabia", "ksa"],
    "SD": ["sd", "sdn", "sudan"],
    "SE": ["se", "swe", "sweden"],
    "SG": ["sg", "sgp", "singapore"],
    "SI": ["si", "svn", "slovenia"],
    "SK": ["sk", "svk", "slovakia"],
    "SL": ["sl", "sle", "sierra leone"],
    "SN": ["sn", "sen", "senegal"],
    "SO": ["so", "som", "somalia"],
    "SR": ["sr", "sur", "suriname"],
    "SS": ["ss", "ssd", "south sudan"],
    "SV": ["sv", "slv", "el salvador"],
    "SY": ["sy", "syr", "syria", "syrian arab republic"],
    "SZ": ["sz", "swz", "eswatini", "swaziland"],
    "TD": ["td", "tcd", "chad"],
    "TG": ["tg", "tgo", "togo"],
    "TH": ["th", "tha", "thailand"],
    "TJ": ["tj", "tjk", "tajikistan"],
    "TM": ["tm", "tkm", "turkmenistan"],
    "TN": ["tn", "tun", "tunisia"],
    "TR": ["tr", "tur", "turkey", "türkiye", "turkiye"],
    "TT": ["tt", "tto", "trinidad and tobago", "trinidad & tobago"],
    "TW": ["tw", "twn", "taiwan"],
    "TZ": ["tz", "tza", "tanzania"],
    "UA": ["ua", "ukr", "ukraine"],
    "UG": ["ug", "uga", "uganda"],
    "US": ["us", "usa", "united states", "united states of america", "america", "u.s.", "u.s.a."],
    "UY": ["uy", "ury", "uruguay"],
    "UZ": ["uz", "uzb", "uzbekistan"],
    "VE": ["ve", "ven", "venezuela"],
    "VN": ["vn", "vnm", "vietnam", "viet nam"],
    "YE": ["ye", "yem", "yemen"],
    "ZA": ["za", "zaf", "south africa"],
    "ZM": ["zm", "zmb", "zambia"],
    "ZW": ["zw", "zwe", "zimbabwe"],
}


# Inverse map for O(1) lookup. Built once at import time.
_NAME_TO_CODE: dict[str, str] = {}
for _code, _names in _CODE_TO_NAMES.items():
    for _name in _names:
        _NAME_TO_CODE[_name] = _code


def normalize_country(value: str) -> str:
    """Return the ISO-2 code for ``value`` or ``""`` if unknown.

    Accepts any of: 2-letter code, 3-letter code, full English name, and a
    handful of common aliases per country (e.g. "UK" → "GB").
    """
    if not isinstance(value, str):
        return ""
    norm = value.strip().lower()
    if not norm:
        return ""
    if norm in _NAME_TO_CODE:
        return _NAME_TO_CODE[norm]
    # Strip common punctuation and try again
    cleaned = norm.replace(".", "").replace(",", "").strip()
    if cleaned in _NAME_TO_CODE:
        return _NAME_TO_CODE[cleaned]
    # 2-letter codes are uppercased on the way out
    if len(norm) == 2 and norm.upper() in _CODE_TO_NAMES:
        return norm.upper()
    return ""


def is_valid_iso2(code: str) -> bool:
    return isinstance(code, str) and code.upper() in _CODE_TO_NAMES


def known_codes() -> list[str]:
    """List of all known ISO-2 codes, sorted."""
    return sorted(_CODE_TO_NAMES.keys())
