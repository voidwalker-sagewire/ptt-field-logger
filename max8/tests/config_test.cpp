#include "Max8Config.hpp"
#include "nvs.h"
#include <cassert>
#include <algorithm>
#include <cstring>
#include <iostream>
#include <vector>

// Test double for API failures/invalid storage, not a model of flash durability.
std::vector<unsigned char> stored;
bool failOpen = false, failSet = false, failCommit = false;
int writes = 0, commits = 0;
esp_err_t nvs_open(const char *ns, int, nvs_handle_t *h) {
  assert(!strcmp(ns, "max8")); *h = 1; return failOpen ? ESP_FAIL : ESP_OK;
}
esp_err_t nvs_get_blob(nvs_handle_t, const char *key, void *out, size_t *length) {
  assert(!strcmp(key, "config_v1"));
  if (stored.empty()) return ESP_ERR_NVS_NOT_FOUND;
  if (*length < stored.size()) return ESP_FAIL;
  *length = stored.size(); memcpy(out, stored.data(), stored.size()); return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t, const char *key, const void *data, size_t length) {
  assert(!strcmp(key, "config_v1")); ++writes;
  if (failSet) return ESP_FAIL;
  const auto *p = static_cast<const unsigned char *>(data);
  stored.assign(p, p + length); return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t) { ++commits; return failCommit ? ESP_FAIL : ESP_OK; }
esp_err_t nvs_erase_key(nvs_handle_t, const char *key) {
  assert(!strcmp(key, "config_v1"));
  stored.clear(); return ESP_OK;
}
void nvs_close(nvs_handle_t) {}

int main() {
  using namespace max8;
  const Config good{"https://voice.example.org/api/max8/turn", std::string(64, 'a')};
  Config result;
  assert(!loadConfig(result));
  for (const auto &url : {
    "http://voice.example.org/api/max8/turn", "https://user@host/api/max8/turn",
    "https://host/api/max8/turn?token=x", "https://host/api/max8/turn#secret",
    "https://host:80/api/max8/turn", "https://host/stt/transcribe",
    "https://host/health", "https://host./api/max8/turn", "https://-host/api/max8/turn",
    "https://ho\\st/api/max8/turn", "https://host\r\nInjected/api/max8/turn",
    "https://host%40evil/api/max8/turn", "https:///api/max8/turn", "https://a..b/api/max8/turn"
  }) assert(!validEndpoint(url));
  assert(validEndpoint(good.endpoint));
  assert(validEndpoint("https://voice.example.org:443/api/max8/turn"));
  assert(!validEndpoint("https://" + std::string(64, 'a') + "/api/max8/turn"));
  assert(validToken(std::string(32, 'a')) && validToken(std::string(128, '_')));
  for (const auto &token : {std::string(31, 'a'), std::string(129, 'a'), std::string(31, 'a')+"\n", std::string(31, 'a')+" "})
    assert(!validToken(token));
  assert(!saveConfig({"http://unsafe", good.token}) && writes == 0);
  assert(saveConfig(good) && writes == 1 && commits == 1);
  assert(loadConfig(result) && result.endpoint == good.endpoint && result.token == good.token);
  failOpen = true; assert(!loadConfig(result) && result.token.empty());
  assert(!saveConfig(good)); failOpen = false;
  failSet = true; assert(!saveConfig(good) && commits == 1); failSet = false;
  failCommit = true; assert(!saveConfig(good)); failCommit = false;
  stored[0] = 2; assert(!loadConfig(result) && result.token.empty());
  assert(saveConfig(good)); stored.pop_back(); assert(!loadConfig(result));
  assert(saveConfig(good)); std::fill(stored.begin()+1, stored.end(), 'x'); assert(!loadConfig(result));
  assert(saveConfig(good)); assert(clearConfig()); assert(!loadConfig(result));
  assert(clearConfig());
  std::cout << "Config validation, storage round trip, corruption and API failure checks passed\n";
}
