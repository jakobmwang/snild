from __future__ import annotations

from pathlib import Path

import pytest

from snild.config import ConfigError, load_config, parse_config
from snild.tools import ToolContract


def test_no_config_file_means_no_models(tmp_path: Path):
    config = load_config(tmp_path / "missing.toml", env={})
    assert config.models == () and config.default_model is None and not config.emulator_enabled


def test_the_test_model_comes_from_the_environment_only():
    assert parse_config({}, {"SNILD_ENABLE_EMULATOR": "1"}).default_model == "emulator"
    with pytest.raises(ConfigError, match="SNILD_ENABLE_EMULATOR"):
        parse_config({"models": [{"id": "t", "provider": "emulator", "model": "x"}]}, {})


@pytest.mark.parametrize("raw, message", [
    ({"serverr": {}}, "unknown key"),
    ({"server": {"port": 1}}, r"\[server\]: unknown key"),
    ({"server": {"public_url": "https://snild.example.org/chat"}}, r"public_url .* must look like"),
    ({"server": {"public_url": "ftp://snild.example.org"}}, r"public_url .* must look like"),
    ({"server": {"public_url": "https://user:pw@snild.example.org"}}, r"public_url .* must look like"),
    ({"server": {"public_url": "https://snild.example.org:99999"}}, r"public_url .* must look like"),
    ({"server": {"public_url": "https://snild_example.org"}}, r"public_url .* must look like"),
    ({"server": {"public_url": "https://@snild.example.org"}}, r"public_url .* must look like"),
    ({"server": {"public_url": "http://[127.0.0.1]:8080"}}, r"public_url .* must look like"),
    ({"server": {"public_url": "https://[snild.example.org]"}}, r"public_url .* must look like"),
    ({"server": {"trusted_proxies": ["0.0.0.0/0"]}}, r"would trust every address"),
    ({"llm": {"default_model": "nope"}}, "not the id of any"),
    ({"models": [{"id": "m", "provider": "openai", "model": "x"}]}, "not available in this version yet"),
    ({"models": [{"id": "m", "provider": "mystery", "model": "x"}]}, "unknown provider"),
])
def test_mistakes_are_reported_clearly(raw, message):
    with pytest.raises(ConfigError, match=message):
        parse_config(raw, {})


def test_keys_must_come_from_the_environment():
    from snild.config import _resolve_secret

    with pytest.raises(ConfigError, match="must name an environment variable"):
        _resolve_secret("sk-literal", {}, "here")
    with pytest.raises(ConfigError, match="MY_KEY"):
        _resolve_secret("env:MY_KEY", {}, "here")
    assert _resolve_secret("env:MY_KEY", {"MY_KEY": "secret"}, "here") == "secret"


def test_tool_arguments_are_checked_against_the_contract():
    contract = ToolContract(enable_all=True)
    assert contract.check_arguments("run_js", '{"code": "return 1"}', set()) == ({"code": "return 1"}, None)
    assert "not valid JSON" in contract.check_arguments("run_js", '{"code": ', set())[1]
    assert "missing 'code'" in contract.check_arguments("run_js", "{}", set())[1]
    assert "unexpected 'x'" in contract.check_arguments("run_js", '{"code": "", "x": 1}', set())[1]
    assert "no tool named 'fetch_url'" in contract.check_arguments("fetch_url", '{"url": "https://a"}', set())[1]
    assert contract.check_arguments("fetch_url", '{"url": "https://a"}', {"web"})[1] is None
    assert [t.name for t in contract.offered(set())] == ["run_js", "render_html"]


def test_a_named_config_file_must_exist(tmp_path: Path):
    with pytest.raises(ConfigError, match="no such file"):
        load_config(env={"SNILD_CONFIG": str(tmp_path / "typo.toml")})


def test_an_empty_data_dir_variable_means_the_default():
    assert str(parse_config({}, {"SNILD_DATA_DIR": ""}).data_dir) == "data"


def test_booleans_are_not_numbers_and_nan_is_not_json():
    from snild.tools import _check

    assert _check(True, {"type": "number"}, "x") == "x must be of type number"
    assert _check(True, {"type": "integer"}, "x") == "x must be of type integer"
    assert _check(True, {"type": "boolean"}, "x") is None
    problem = ToolContract(enable_all=True).check_arguments("run_js", '{"code": NaN}', set())[1]
    assert "not valid JSON" in problem


def test_huge_numbers_are_not_json_either():
    assert "too large" in ToolContract(enable_all=True).check_arguments("run_js", '{"code": 1e999}', set())[1]


def test_a_hidden_default_model_is_refused(monkeypatch):
    import snild.config as config_module

    monkeypatch.setattr(config_module, "PROVIDERS_PLANNED", frozenset())
    monkeypatch.setattr(config_module, "PROVIDERS_AVAILABLE", frozenset({"emulator", "openai"}))
    raw = {"llm": {"default_model": "m"}, "models": [{"id": "m", "provider": "openai", "model": "x", "hidden": True}]}
    with pytest.raises(ConfigError, match="is hidden"):
        parse_config(raw, {})
