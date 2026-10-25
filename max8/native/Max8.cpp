#include "Max8.hpp"
#include "Max8Config.hpp"
#include "bsp/esp-bsp.h"
#include "bsp_board_extra.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_wifi.h"
#include "esp_log.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <algorithm>
#include <cstring>
#include <cstdlib>
#include <string>

LV_IMG_DECLARE(img_app_recorder);
namespace esp_brookesia::apps {
namespace {
static const char *TAG = "MAX8";
enum Phase { Idle=0, Recording=1, Thinking=2, Speaking=3, Failed=4, Done=5,
             SetupNeeded=6, NoWifi=7, BusyAudio=8, CaptureError=9, HttpError=10, CodecError=11 };
std::atomic<int> phase{Idle};
constexpr int SAMPLE_RATE=24000;
constexpr size_t FRAMES=72000; // 3-second local capture
constexpr size_t WAV_BYTES=44+FRAMES*2;
constexpr size_t AUDIO_MAX=2*1024*1024;

void rect(lv_obj_t *root, int x, int y, int w, int h, uint32_t color, int radius=0) {
  lv_obj_t *o=lv_obj_create(root);
  lv_obj_remove_style_all(o);
  lv_obj_set_pos(o,x,y); lv_obj_set_size(o,w,h);
  lv_obj_set_style_bg_opa(o,LV_OPA_COVER,0);
  lv_obj_set_style_bg_color(o,lv_color_hex(color),0);
  lv_obj_set_style_radius(o,radius,0);
  lv_obj_remove_flag(o,LV_OBJ_FLAG_SCROLLABLE);
}
lv_obj_t *txt(lv_obj_t *root,const char *s,int x,int y,int w,uint32_t color) {
  lv_obj_t *o=lv_label_create(root);
  lv_label_set_text(o,s); lv_obj_set_pos(o,x,y); lv_obj_set_width(o,w);
  lv_obj_set_style_text_color(o,lv_color_hex(color),0);
  lv_obj_set_style_text_align(o,LV_TEXT_ALIGN_CENTER,0);
  return o;
}
lv_obj_t *button(lv_obj_t *root,const char *s,int x,int y,int w,int h,uint32_t color,
                 lv_event_cb_t cb,void *self) {
  lv_obj_t *b=lv_button_create(root);lv_obj_set_pos(b,x,y);lv_obj_set_size(b,w,h);
  lv_obj_set_style_bg_color(b,lv_color_hex(0x182036),0);
  lv_obj_set_style_border_color(b,lv_color_hex(color),0);
  lv_obj_set_style_border_width(b,2,0);
  lv_obj_set_style_radius(b,10,0);
  lv_obj_t *l=lv_label_create(b);lv_label_set_text(l,s);lv_obj_center(l);
  lv_obj_add_event_cb(b,cb,LV_EVENT_CLICKED,self);
  return b;
}
void put16(uint8_t *p,uint16_t v){p[0]=(uint8_t)v;p[1]=(uint8_t)(v>>8);}
void put32(uint8_t *p,uint32_t v){for(int i=0;i<4;++i)p[i]=(uint8_t)(v>>(8*i));}
void makeHeader(uint8_t *p,uint32_t bytes,uint16_t rate,uint16_t chans){
  memcpy(p,"RIFF",4);put32(p+4,36+bytes);memcpy(p+8,"WAVEfmt ",8);
  put32(p+16,16);put16(p+20,1);put16(p+22,chans);put32(p+24,rate);
  put32(p+28,rate*chans*2);put16(p+32,chans*2);put16(p+34,16);
  memcpy(p+36,"data",4);put32(p+40,bytes);
}
struct WavInfo {uint32_t rate=0;uint16_t channels=0;const uint8_t *pcm=nullptr;size_t bytes=0;};
bool parseWav(const uint8_t *src,size_t n,WavInfo &w){
  if(n<44 || memcmp(src,"RIFF",4) || memcmp(src+8,"WAVE",4))return false;
  size_t pos=12;bool fmt=false;
  while(pos+8<=n){
    const uint32_t len=(uint32_t)src[pos+4]|((uint32_t)src[pos+5]<<8)|
                       ((uint32_t)src[pos+6]<<16)|((uint32_t)src[pos+7]<<24);
    if(len>n-pos-8)return false;
    if(!memcmp(src+pos,"fmt ",4)&&len>=16){
      const uint8_t *p=src+pos+8;
      const uint16_t encoding=p[0]|(p[1]<<8);w.channels=p[2]|(p[3]<<8);
      w.rate=(uint32_t)p[4]|((uint32_t)p[5]<<8)|((uint32_t)p[6]<<16)|((uint32_t)p[7]<<24);
      const uint16_t bits=p[14]|(p[15]<<8);
      if(encoding!=1||bits!=16||w.channels<1||w.channels>2||w.rate<8000||w.rate>48000)return false;
      fmt=true;
    }
    if(!memcmp(src+pos,"data",4)){w.pcm=src+pos+8;w.bytes=len;}
    pos+=8+len+(len&1);
  }
  return fmt && w.pcm && w.bytes && (w.bytes%(w.channels*2)==0);
}
bool readConfig(std::string &url,std::string &token) {
  max8::Config config;
  if(!max8::loadConfig(config))return false;
  url=config.endpoint;token=config.token;
  return true;
}
bool sendAll(esp_http_client_handle_t c,const uint8_t *data,size_t length){
  size_t off=0;
  while(off<length){
    int n=esp_http_client_write(c,(const char*)data+off,(int)std::min<size_t>(length-off,4096));
    if(n<=0) return false;
    off += (size_t)n;
  }
  return true;
}
bool cloudTurn(const uint8_t *wav,size_t wavLength,uint8_t *out,size_t &used) {
  std::string url,token;
  if(!readConfig(url,token)){phase.store(SetupNeeded);return false;}
  wifi_ap_record_t ap={};
  if(esp_wifi_sta_get_ap_info(&ap)!=ESP_OK){phase.store(NoWifi);return false;}
  constexpr const char *boundary="----MAX8WatchAudio";
  std::string pre=std::string("--")+boundary+"\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"max8.wav\"\r\nContent-Type: audio/wav\r\n\r\n";
  std::string post=std::string("\r\n--")+boundary+"--\r\n";
  esp_http_client_config_t config={};
  config.url=url.c_str();config.crt_bundle_attach=esp_crt_bundle_attach;
  config.timeout_ms=90000;config.buffer_size=4096;config.buffer_size_tx=4096;
  config.disable_auto_redirect=true; // never forward the device token to another host
  esp_http_client_handle_t c=esp_http_client_init(&config);
  if(!c){phase.store(HttpError);return false;}
  esp_http_client_set_method(c,HTTP_METHOD_POST);
  std::string auth="Bearer "+token;
  std::string ctype=std::string("multipart/form-data; boundary=")+boundary;
  esp_http_client_set_header(c,"Authorization",auth.c_str());
  esp_http_client_set_header(c,"Content-Type",ctype.c_str());
  const int length=(int)(pre.size()+wavLength+post.size());
  bool ok=esp_http_client_open(c,length)==ESP_OK;
  if(ok)ok=sendAll(c,(const uint8_t*)pre.data(),pre.size());
  if(ok)ok=sendAll(c,wav,wavLength);
  if(ok)ok=sendAll(c,(const uint8_t*)post.data(),post.size());
  int headers=ok?esp_http_client_fetch_headers(c):-1;
  const int status=ok?esp_http_client_get_status_code(c):0;
  ok=ok && headers>=-1 && status==200;
  used=0;
  while(ok && used<AUDIO_MAX) {
    const int n=esp_http_client_read(c,(char*)out+used,(int)std::min<size_t>(8192,AUDIO_MAX-used));
    if(n<0){ok=false;break;}
    if(n==0)break;
    used+=(size_t)n;
  }
  if(used==AUDIO_MAX)ok=false;
  esp_http_client_close(c);esp_http_client_cleanup(c);
  if(!ok){ESP_LOGW(TAG,"MAX8 gateway request failed HTTP %d",status);phase.store(HttpError);return false;}
  WavInfo parsed;
  if(!parseWav(out,used,parsed)){phase.store(HttpError);return false;}
  return true;
}
} // namespace

Max8 *Max8::instance_=nullptr;
Max8 *Max8::requestInstance(bool status,bool nav) {
  if(!instance_)instance_=new Max8(status,nav);
  return instance_;
}
Max8::Max8(bool status,bool nav):App("MAX-8",&img_app_recorder,true,status,nav){}
Max8::~Max8(){(void)close();instance_=nullptr;}
bool Max8::init(){phase.store(Idle);return true;}
bool Max8::deinit(){return close();}
bool Max8::pause(){return !busy_.load();}
bool Max8::resume(){return true;}
bool Max8::back(){return !busy_.load() && notifyCoreClosed();}
bool Max8::close(){
  if(busy_.load())return false; // do not destroy UI or App while its worker is alive
  releaseUi();return true;
}
void Max8::releaseUi(){
  hideSetup();
  if(timer_){lv_timer_del(timer_);timer_=nullptr;}
  status_=mouth_=talk_=battery_=nullptr;
}
void Max8::makeUi(){
  lv_obj_t *root=lv_screen_active();
  lv_obj_set_style_bg_color(root,lv_color_hex(0x020309),0);
  rect(root,26,72,358,329,0x10172B,14);
  rect(root,33,78,344,312,0x182340,12);
  for(int y=95;y<390;y+=35)rect(root,35,y,338,2,0x29324C);
  txt(root,"MAX-8",55,9,300,0x03E6ED);
  txt(root,"// THE SIGNAL HOST //",68,39,275,0xB7C9DF);
  // Fixed-position digital host bust: stationary figure, moving mouth during speech.
  rect(root,98,323,216,82,0x25203D,24); // jacket
  rect(root,157,308,94,96,0x41496D,12); // lapels
  rect(root,192,320,26,85,0xD930A2,4); // necktie
  rect(root,187,271,36,70,0xCF9B84,8); // neck
  rect(root,141,140,128,158,0xC99580,32); // face
  rect(root,145,100,128,78,0x25213C,30); // quiff
  rect(root,162,94,84,23,0x423657,12);
  rect(root,167,196,28,12,0xEDF5EC,6); // eye
  rect(root,217,196,28,12,0xEDF5EC,6);
  rect(root,177,198,9,9,0x0C8C99,5);
  rect(root,227,198,9,9,0x0C8C99,5);
  rect(root,164,184,34,5,0x342239,2);
  rect(root,215,184,34,5,0x342239,2);
  rect(root,200,218,9,29,0xA26D62,4); // nose
  mouth_=lv_obj_create(root);lv_obj_remove_style_all(mouth_);
  lv_obj_set_pos(mouth_,183,263);lv_obj_set_size(mouth_,44,5);
  lv_obj_set_style_bg_color(mouth_,lv_color_hex(0x4A102E),0);
  lv_obj_set_style_bg_opa(mouth_,LV_OPA_COVER,0);
  lv_obj_set_style_radius(mouth_,5,0);
  txt(root,"LIVE // 08",41,81,93,0x14E5D5);
  txt(root,"SAGEWIRE",290,81,94,0x14E5D5);
  status_=txt(root,"READY - PRESS TALK",42,413,326,0xFFD766);
  talk_=button(root,"TALK",24,461,111,38,0x03E6ED,&Max8::talkButton,this);
  button(root,"MUSIC",147,461,114,38,0xEF36BC,&Max8::musicButton,this);
  button(root,"SETUP",273,461,110,38,0xBDD8E8,&Max8::setupButton,this);
  battery_=txt(root,"MAX-8 NATIVE",155,438,100,0xA9B2D0);
  timer_=lv_timer_create(&Max8::refreshUi,90,this);
}
bool Max8::run(){
  releaseUi();closing_.store(false);
  max8::Config config;
  phase.store(max8::loadConfig(config)?Idle:SetupNeeded);
  makeUi();return true;
}
void Max8::hideSetup(){
  if(token_)lv_textarea_set_text(token_,"");
  if(setup_)lv_obj_delete(setup_);
  setup_=endpoint_=token_=keyboard_=setupMessage_=nullptr;
  clearArmed_=false;
}
void Max8::setupButton(lv_event_t *ev){
  auto *self=(Max8*)lv_event_get_user_data(ev);
  if(self && !self->busy_.load())self->showSetup();
}
void Max8::setupFocus(lv_event_t *ev){
  auto *self=(Max8*)lv_event_get_user_data(ev);
  if(self && self->keyboard_) {
    self->clearArmed_=false;
    lv_keyboard_set_textarea(self->keyboard_,(lv_obj_t*)lv_event_get_target(ev));
  }
}
void Max8::showSetup(){
  if(setup_ || busy_.load())return;
  setup_=lv_obj_create(lv_screen_active());
  lv_obj_set_pos(setup_,0,0);lv_obj_set_size(setup_,410,502);
  lv_obj_set_style_pad_all(setup_,0,0);
  lv_obj_set_style_bg_color(setup_,lv_color_hex(0x10172B),0);
  lv_obj_remove_flag(setup_,LV_OBJ_FLAG_SCROLLABLE);
  txt(setup_,"MAX-8 SETUP",25,8,360,0x03E6ED);
  setupMessage_=txt(setup_,"Wi-Fi: launcher > Settings > WLAN",15,34,380,0xFFD766);
  endpoint_=lv_textarea_create(setup_);
  lv_obj_set_pos(endpoint_,15,62);lv_obj_set_size(endpoint_,380,48);
  lv_textarea_set_one_line(endpoint_,true);
  lv_textarea_set_max_length(endpoint_,191);
  lv_textarea_set_placeholder_text(endpoint_,"HTTPS URL ending /api/max8/turn");
  token_=lv_textarea_create(setup_);
  lv_obj_set_pos(token_,15,118);lv_obj_set_size(token_,380,48);
  lv_textarea_set_one_line(token_,true);
  lv_textarea_set_max_length(token_,128);
  lv_textarea_set_password_mode(token_,true);
  lv_textarea_set_password_show_time(token_,0);
  max8::Config config;
  const bool saved=max8::loadConfig(config);
  if(saved)lv_textarea_set_text(endpoint_,config.endpoint.c_str());
  lv_textarea_set_placeholder_text(token_,saved?"Token: blank keeps saved value":"Device token (32-128 characters)");
  lv_obj_add_event_cb(endpoint_,&Max8::setupFocus,LV_EVENT_FOCUSED,this);
  lv_obj_add_event_cb(token_,&Max8::setupFocus,LV_EVENT_FOCUSED,this);
  button(setup_,"SAVE",15,178,118,42,0x03E6ED,&Max8::setupAction,this);
  button(setup_,"CLEAR",146,178,118,42,0xEF36BC,&Max8::setupAction,this);
  button(setup_,"CLOSE",277,178,118,42,0xBDD8E8,&Max8::setupAction,this);
  txt(setup_,"Saved locally. Save does not test voice.",15,228,380,0xA9B2D0);
  keyboard_=lv_keyboard_create(setup_);
  lv_obj_set_size(keyboard_,410,240);lv_obj_align(keyboard_,LV_ALIGN_BOTTOM_MID,0,0);
  lv_keyboard_set_mode(keyboard_,LV_KEYBOARD_MODE_TEXT_LOWER);
  lv_keyboard_set_textarea(keyboard_,endpoint_);
}
void Max8::setupAction(lv_event_t *ev){
  auto *self=(Max8*)lv_event_get_user_data(ev);
  if(!self || self->busy_.load() || !self->setup_)return;
  auto *b=(lv_obj_t*)lv_event_get_target(ev);
  const char *action=lv_label_get_text(lv_obj_get_child(b,0));
  if(!strcmp(action,"CLOSE")){self->hideSetup();return;}
  if(!strcmp(action,"CLEAR")){
    if(!self->clearArmed_){
      self->clearArmed_=true;
      lv_label_set_text(self->setupMessage_,"Press CLEAR again to forget MAX-8 setup");return;
    }
    self->clearArmed_=false;
    if(max8::clearConfig()){
      lv_textarea_set_text(self->endpoint_,"");lv_textarea_set_text(self->token_,"");
      lv_textarea_set_placeholder_text(self->token_,"Device token (32-128 characters)");
      phase.store(SetupNeeded);
      lv_label_set_text(self->setupMessage_,"MAX-8 cleared. Wi-Fi unchanged.");
    }else lv_label_set_text(self->setupMessage_,"Could not clear setup. Try again.");
    return;
  }
  self->clearArmed_=false;
  max8::Config config;
  max8::loadConfig(config);
  config.endpoint=lv_textarea_get_text(self->endpoint_);
  const char *newToken=lv_textarea_get_text(self->token_);
  if(*newToken)config.token=newToken;
  if(!max8::validEndpoint(config.endpoint)){
    lv_label_set_text(self->setupMessage_,"Use https://host/api/max8/turn (port 443)");return;
  }
  if(!max8::validToken(config.token)){
    lv_label_set_text(self->setupMessage_,"Token: 32-128 letters, digits, - or _");return;
  }
  if(!max8::saveConfig(config)){
    lv_label_set_text(self->setupMessage_,"Save failed. Setup is not confirmed.");return;
  }
  lv_textarea_set_text(self->token_,"");
  lv_textarea_set_placeholder_text(self->token_,"Token: blank keeps saved value");
  phase.store(Idle);
  lv_label_set_text(self->setupMessage_,"Saved locally. Voice is not yet verified.");
}
void Max8::talkButton(lv_event_t *ev){
  auto *self=(Max8*)lv_event_get_user_data(ev);
  if(!self || self->busy_.exchange(true))return;
  phase.store(Recording);
  self->workerDone_.store(false);
  if(xTaskCreatePinnedToCore(&Max8::voiceTask,"max8_turn",12288,self,5,nullptr,0)!=pdPASS){
    self->busy_.store(false);self->workerDone_.store(true);phase.store(Failed);
  }
}
void Max8::musicButton(lv_event_t *ev){
  auto *self=(Max8*)lv_event_get_user_data(ev);
  if(self && !self->busy_.load())self->back(); // opens native Brookesia launcher (MusicPlayer installed)
}
void Max8::refreshUi(lv_timer_t *timer){
  auto *self=(Max8*)lv_timer_get_user_data(timer);if(!self || !self->status_)return;
  const char *msg="READY - PRESS TALK";
  switch(phase.load()){
    case Recording:msg="LISTENING...";break;
    case Thinking:msg="MAX-8 IS THINKING...";break;
    case Speaking:msg="TRANSMITTING RESPONSE";break;
    case Failed:msg="AUDIO TASK FAILED";break;
    case Done:msg="READY FOR NEXT QUESTION";break;
    case SetupNeeded:msg="OPEN SETUP TO CONFIGURE MAX-8";break;
    case NoWifi:msg="CONNECT WIFI IN SETTINGS";break;
    case BusyAudio:msg="SPEAKER / MUSIC IS BUSY";break;
    case CaptureError:msg="MIC CAPTURE FAILED";break;
    case HttpError:msg="SAGEWIRE REQUEST FAILED";break;
    case CodecError:msg="AUDIO CODEC NOT READY";break;
    default:break;
  }
  lv_label_set_text(self->status_,msg);
  if(self->mouth_)lv_obj_set_height(self->mouth_,5+self->mouthLevel_.load()/14);
}
void Max8::voiceTask(void *arg) {
  auto *self=(Max8*)arg;self->doConversation();
  self->mouthLevel_.store(0);self->workerDone_.store(true);self->busy_.store(false);
  vTaskDelete(nullptr);
}
void Max8::doConversation(){
  // Fail before microphone capture, allocation or codec acquisition.
  {
    max8::Config config;
    if(!max8::loadConfig(config)){phase.store(SetupNeeded);return;}
    wifi_ap_record_t ap={};
    if(esp_wifi_sta_get_ap_info(&ap)!=ESP_OK){phase.store(NoWifi);return;}
  }
  // Never start capture while factory MusicPlayer or Recorder owns shared codec.
  if(bsp_extra_audio_session_acquire(BSP_EXTRA_AUDIO_OWNER_MAX8)!=ESP_OK){
    phase.store(BusyAudio);return;
  }
  uint8_t *wave=(uint8_t*)heap_caps_malloc(WAV_BYTES,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
  uint8_t *reply=(uint8_t*)heap_caps_malloc(AUDIO_MAX,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
  bool session=true;
  if(!wave || !reply){phase.store(Failed);goto cleanup;}
  if(bsp_extra_codec_init()!=ESP_OK ||
      bsp_extra_codec_set_voice_fs(SAMPLE_RATE,16,4,0x0F,0x03)!=ESP_OK){
    phase.store(CodecError);goto cleanup;
  }
  makeHeader(wave,FRAMES*2,SAMPLE_RATE,1);
  {
    int16_t buffer[256*4];size_t count=0;
    for(size_t frame=0;frame<FRAMES && !closing_.load();){
      size_t n=0;
      size_t batch=std::min<size_t>(256,FRAMES-frame);
      esp_err_t error=bsp_extra_i2s_read(buffer,batch*4*sizeof(int16_t),&n,1200);
      if(error!=ESP_OK || n!=batch*4*sizeof(int16_t)){phase.store(CaptureError);goto cleanup;}
      for(size_t i=0;i<batch;++i){
        // The native factory Recorder uses slot 0 for MIC1 and slot 2 for MIC2.
        // Keep actual unmodified MIC1 PCM for lossless STT input.
        put16(wave+44+2*(frame+i),(uint16_t)buffer[i*4]);
      }
      frame+=batch;count+=n;
    }
    if(closing_.load()){phase.store(Failed);goto cleanup;}
  }
  (void)bsp_extra_codec_dev_stop();
  phase.store(Thinking);
  {
    size_t used=0;
    if(!cloudTurn(wave,WAV_BYTES,reply,used))goto cleanup;
    WavInfo decoded;
    if(!parseWav(reply,used,decoded)){phase.store(HttpError);goto cleanup;}
    if(bsp_extra_codec_set_fs(decoded.rate,16,I2S_SLOT_MODE_STEREO)!=ESP_OK){
      phase.store(CodecError);goto cleanup;
    }
    phase.store(Speaking);
    const size_t frameCount=decoded.bytes/(2*decoded.channels);
    const int16_t *pcm=(const int16_t*)decoded.pcm;
    int16_t stereo[512*2];
    for(size_t at=0;at<frameCount;){
      size_t batch=std::min<size_t>(512,frameCount-at);uint16_t peak=0;
      for(size_t i=0;i<batch;++i){
        int16_t a=pcm[(at+i)*decoded.channels];
        int16_t b=decoded.channels==2?pcm[(at+i)*2+1]:a;
        stereo[i*2]=a;stereo[i*2+1]=b;
        const int m=std::max(abs((int)a),abs((int)b));
        if(m>peak)peak=(uint16_t)std::min(m,32767);
      }
      mouthLevel_.store((uint8_t)(peak/130));
      size_t written=0;
      if(bsp_extra_i2s_write(stereo,batch*4,&written,1500)!=ESP_OK ||
          written!=batch*4){phase.store(CodecError);goto cleanup;}
      at+=batch;
    }
    phase.store(Done);
  }
cleanup:
  mouthLevel_.store(0);
  (void)bsp_extra_codec_dev_stop();
  if(wave)heap_caps_free(wave);
  if(reply)heap_caps_free(reply);
  if(session)(void)bsp_extra_audio_session_release(BSP_EXTRA_AUDIO_OWNER_MAX8);
}
} // namespace esp_brookesia::apps
