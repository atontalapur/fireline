import common


def test_regions_have_bbox():
    for meta in common.REGIONS.values():
        w, s, e, n = meta["bbox"]
        assert w < e and s < n
