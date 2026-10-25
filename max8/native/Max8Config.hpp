#pragma once
#include <string>

namespace max8 {
// A single versioned NVS value keeps endpoint/token updates together.
struct Config { std::string endpoint; std::string token; };
bool validEndpoint(const std::string &endpoint);
bool validToken(const std::string &token);
bool loadConfig(Config &config);
bool saveConfig(const Config &config);
bool clearConfig();
}
