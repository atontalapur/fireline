import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

import render_method as rm

PIPELINE_DIR = Path(__file__).resolve().parent.parent


def synthetic_validation() -> dict:
    region = {
        "raw_bias": 4.2345,
        "harmonized_bias": 1.0123,
        "loyo_r": 0.91234,
        "loyo_nrmse": 0.2468,
        "forward_r": None,
        "seam_ratio": 0.987,
        "changepoint_p": 0.0004,
        "placebo": [{"date": "2016-01", "changepoint_p": 0.4}],
        "peak_month_match": 0.875,
        "figures": {"scatter": "figures/scatter_pantanal.png"},
    }
    return {
        "method_version": "1.0",
        "regions": {
            "pantanal": region,
            "w_canada": {**region, "changepoint_p": 0.4321},
        },
        "sentinel3": {"spearman_r": 0.8123},
    }


def test_fills_and_rounds_region_metrics():
    tpl = (
        "{{pantanal.raw_bias}} {{pantanal.harmonized_bias}} {{pantanal.loyo_r}} "
        "{{pantanal.loyo_nrmse}} {{pantanal.seam_ratio}} {{pantanal.changepoint_p}} "
        "{{w_canada.changepoint_p}} {{pantanal.peak_month_match}} {{method_version}}"
    )
    out = rm.render(tpl, synthetic_validation())
    body = out.removeprefix(rm.HEADER)
    assert body == "4.23x 1.01x 0.91 0.25 0.99x < 0.001 0.43 88% 1.0"


def test_null_and_missing_region_render_na():
    out = rm.render("{{pantanal.forward_r}} {{punjab.loyo_r}}", synthetic_validation())
    assert out.removeprefix(rm.HEADER) == "n/a n/a"


def test_sentinel3_top_level_and_region_fallback():
    v = synthetic_validation()
    assert rm.render("{{sentinel3.spearman_r}}", v).endswith("0.81")
    nested = synthetic_validation()
    del nested["sentinel3"]
    nested["regions"]["pantanal"]["sentinel3"] = {"spearman_r": 0.5}
    assert rm.render("{{sentinel3.spearman_r}}", nested).endswith("0.50")
    del nested["regions"]["pantanal"]["sentinel3"]
    assert rm.render("{{sentinel3.spearman_r}}", nested).endswith("n/a")


def test_pending_mode_fills_every_placeholder():
    out = rm.render("a {{pantanal.loyo_r}} b {{ sentinel3.spearman_r }}", None)
    assert out.removeprefix(rm.HEADER) == "a pending b pending"


def test_unknown_placeholder_raises_even_when_pending():
    with pytest.raises(ValueError):
        rm.render("{{pantanal.loyo_rr}}", None)
    with pytest.raises(ValueError):
        rm.render("{{atlantis.loyo_r}}", synthetic_validation())


def test_nan_and_percent_inputs():
    assert rm.format_value(float("nan"), "loyo_r") == "n/a"
    assert rm.format_value(87.5, "peak_month_match") == "88%"
    assert rm.format_value(12, "n_months") == "12"


def test_repo_template_renders_with_no_leftover_placeholders():
    tpl = rm.TEMPLATE_PATH.read_text()
    keys = rm.PLACEHOLDER.findall(tpl)
    assert keys, "template has no placeholders"
    assert "sentinel3.spearman_r" in keys
    for region in ("pantanal", "w_canada", "punjab"):
        assert f"{region}.loyo_r" in keys
    out = rm.render(tpl, synthetic_validation())
    assert not re.search(r"\{\{|\}\}", out)


def test_committed_method_md_is_a_render_of_current_template():
    # Values may be "pending" or real numbers; the surrounding text must match the template.
    tpl = rm.HEADER + rm.TEMPLATE_PATH.read_text()
    pattern = "".join(
        re.escape(chunk) if i % 2 == 0 else r"[^\n|]+?"
        for i, chunk in enumerate(rm.PLACEHOLDER.split(tpl))
    )
    assert re.fullmatch(pattern, rm.OUTPUT_PATH.read_text(), flags=re.DOTALL)


def test_cli_writes_and_checks(tmp_path):
    tpl = tmp_path / "t.md"
    tpl.write_text("r = {{pantanal.loyo_r}}\n")
    val = tmp_path / "validation.json"
    val.write_text(json.dumps(synthetic_validation()))
    out = tmp_path / "out.md"
    base = [sys.executable, "render_method.py", "--template", str(tpl), "--out", str(out)]
    run = subprocess.run([*base, "--validation", str(val)], cwd=PIPELINE_DIR)
    assert run.returncode == 0
    assert out.read_text().endswith("r = 0.91\n")
    check = subprocess.run([*base, "--validation", str(val), "--check"], cwd=PIPELINE_DIR)
    assert check.returncode == 0
    stale = subprocess.run([*base, "--pending", "--check"], cwd=PIPELINE_DIR)
    assert stale.returncode != 0


def test_placebo_summary_across_regions():
    v = synthetic_validation()
    v["placebo_months"] = ["2008-01", "2015-01", "2023-01"]
    v["regions"]["pantanal"]["placebo"] = [
        {"month": "2008-01", "seam_ratio": 0.4969, "changepoint_p": 0.006},
        {"month": "2015-01", "seam_ratio": 2.99, "changepoint_p": 0.25},
    ]
    v["regions"]["w_canada"]["placebo"] = [
        {"month": "2023-01", "seam_ratio": 11.211, "changepoint_p": 0.004},
        {"month": "2015-01", "seam_ratio": None, "changepoint_p": None},
    ]
    tpl = (
        "{{placebo.months}}; {{placebo.n}}; {{placebo.seam_ratio_min}} to "
        "{{placebo.seam_ratio_max}}; {{placebo.n_changepoint_sig}}"
    )
    out = rm.render(tpl, v).removeprefix(rm.HEADER)
    assert out == "2008-01, 2015-01 and 2023-01; 4; 0.50x to 11.21x; 2"


def test_placebo_missing_and_changepoint_month():
    v = synthetic_validation()
    for region in v["regions"].values():
        region.pop("placebo")
    v["regions"]["pantanal"]["changepoint_month"] = "2019-01"
    out = rm.render(
        "{{placebo.months}} {{placebo.seam_ratio_max}} {{pantanal.changepoint_month}}", v
    )
    assert out.removeprefix(rm.HEADER) == "n/a n/a 2019-01"
