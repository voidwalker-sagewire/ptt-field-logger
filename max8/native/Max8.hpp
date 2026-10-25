#pragma once
#include "lvgl.h"
#include "systems/phone/esp_brookesia_phone_app.hpp"
#include <atomic>
#include <stdint.h>
namespace esp_brookesia::apps {
class Max8 : public systems::phone::App {
public:
 static Max8 *requestInstance(bool status=false, bool nav=false);
 ~Max8() override;
protected:
 Max8(bool status, bool nav);
 bool init() override;
 bool deinit() override;
 bool run() override;
 bool back() override;
 bool close() override;
 bool pause() override;
 bool resume() override;
private:
 static Max8 *instance_;
 static void talkButton(lv_event_t *ev);
 static void musicButton(lv_event_t *ev);
 static void refreshUi(lv_timer_t *timer);
 static void voiceTask(void *arg);
 void updateStatus(const char *s);
 void setMouth(uint8_t amplitude);
 void doConversation();
 void makeUi();
 void releaseUi();
 lv_obj_t *status_ = nullptr;
 lv_obj_t *mouth_ = nullptr;
 lv_obj_t *battery_ = nullptr;
 lv_obj_t *talk_ = nullptr;
 lv_timer_t *timer_ = nullptr;
 std::atomic<bool> busy_{false};
 std::atomic<bool> closing_{false};
 std::atomic<bool> workerDone_{true};
 std::atomic<uint8_t> mouthLevel_{0};
 char statusText_[128] = "READY - PRESS TALK";
};
}