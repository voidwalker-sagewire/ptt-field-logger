#include "Max8Config.hpp"
#include "nvs.h"
#include <cstring>

namespace max8 {
namespace {
constexpr const char *Namespace = "max8";
constexpr const char *Key = "config_v1";
struct StoredConfig {
  unsigned char version;
  char endpoint[192];
  char token[192];
};
void wipe(void *data, size_t length) {
  volatile unsigned char *p = static_cast<volatile unsigned char *>(data);
  while (length--) *p++ = 0;
}
bool alphaNum(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}
}
bool validEndpoint(const std::string &url) {
  // Exact contract path; no userinfo, URL secrets, redirects or ambiguous escaping.
  const std::string prefix = "https://", path = "/api/max8/turn";
  if (url.size() >= sizeof(StoredConfig::endpoint) || url.compare(0, prefix.size(), prefix)) return false;
  const auto slash = url.find('/', prefix.size());
  if (slash == std::string::npos || url.substr(slash) != path) return false;
  std::string host = url.substr(prefix.size(), slash - prefix.size());
  const auto colon = host.find(':');
  if (colon != std::string::npos) {
    if (host.substr(colon) != ":443") return false;
    host.resize(colon);
  }
  if (host.empty() || host.size() > 253) return false;
  size_t start = 0;
  while (start < host.size()) {
    auto end = host.find('.', start);
    if (end == std::string::npos) end = host.size();
    if (end == start || end - start > 63 || !alphaNum(host[start]) || !alphaNum(host[end-1])) return false;
    for (size_t i = start; i < end; ++i) if (!alphaNum(host[i]) && host[i] != '-') return false;
    start = end + 1;
  }
  return host.back() != '.';
}
bool validToken(const std::string &token) {
  if (token.size() < 32 || token.size() > 128) return false;
  for (char c : token) if (!alphaNum(c) && c != '-' && c != '_') return false;
  return true;
}
bool loadConfig(Config &config) {
  config = {};
  nvs_handle_t handle;
  if (nvs_open(Namespace, NVS_READONLY, &handle) != ESP_OK) return false;
  StoredConfig stored = {};
  size_t size = sizeof(stored);
  const auto error = nvs_get_blob(handle, Key, &stored, &size);
  nvs_close(handle);
  bool ok = error == ESP_OK && size == sizeof(stored) && stored.version == 1 &&
            memchr(stored.endpoint, 0, sizeof(stored.endpoint)) && memchr(stored.token, 0, sizeof(stored.token));
  if (ok) {
    config = {stored.endpoint, stored.token};
    ok = validEndpoint(config.endpoint) && validToken(config.token);
  }
  wipe(&stored, sizeof(stored));
  if (!ok) config = {};
  return ok;
}
bool saveConfig(const Config &config) {
  if (!validEndpoint(config.endpoint) || !validToken(config.token)) return false;
  nvs_handle_t handle;
  if (nvs_open(Namespace, NVS_READWRITE, &handle) != ESP_OK) return false;
  StoredConfig stored = {};
  stored.version = 1;
  memcpy(stored.endpoint, config.endpoint.c_str(), config.endpoint.size());
  memcpy(stored.token, config.token.c_str(), config.token.size());
  auto error = nvs_set_blob(handle, Key, &stored, sizeof(stored));
  if (error == ESP_OK) error = nvs_commit(handle);
  nvs_close(handle);
  wipe(&stored, sizeof(stored));
  return error == ESP_OK;
}
bool clearConfig() {
  nvs_handle_t handle;
  if (nvs_open(Namespace, NVS_READWRITE, &handle) != ESP_OK) return false;
  auto error = nvs_erase_key(handle, Key);
  if (error == ESP_ERR_NVS_NOT_FOUND) error = ESP_OK;
  if (error == ESP_OK) error = nvs_commit(handle);
  nvs_close(handle);
  return error == ESP_OK;
}
}
