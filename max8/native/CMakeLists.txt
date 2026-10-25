idf_component_register(
    SRCS "Max8.cpp"
    INCLUDE_DIRS "."
    REQUIRES brookesia_core bsp_extra Recorder MusicPlayer esp_http_client esp-tls mbedtls nvs_flash esp_wifi esp_timer
)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-missing-field-initializers)
