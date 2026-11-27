#include <node_api.h>
#include <linux/input.h>
#include <sys/ioctl.h>
#include <errno.h>
#include <string.h>

static napi_value grab(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2], result; int32_t fd; bool enabled;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 2 || napi_get_value_int32(env, args[0], &fd) != napi_ok || napi_get_value_bool(env, args[1], &enabled) != napi_ok) {
    napi_throw_type_error(env, NULL, "grab(fd, enabled)"); return NULL;
  }
  if (ioctl(fd, EVIOCGRAB, enabled ? 1 : 0) < 0) { napi_throw_error(env, NULL, strerror(errno)); return NULL; }
  napi_get_undefined(env, &result); return result;
}
static napi_value name(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value arg, result; int32_t fd; char buffer[256] = {0};
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  if (argc != 1 || napi_get_value_int32(env, arg, &fd) != napi_ok) { napi_throw_type_error(env, NULL, "name(fd)"); return NULL; }
  if (ioctl(fd, EVIOCGNAME(sizeof(buffer)), buffer) < 0) { napi_throw_error(env, NULL, strerror(errno)); return NULL; }
  napi_create_string_utf8(env, buffer, NAPI_AUTO_LENGTH, &result); return result;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "grab", NULL, grab, NULL, NULL, NULL, napi_default, NULL },
    { "name", NULL, name, NULL, NULL, NULL, napi_default, NULL }
  };
  napi_define_properties(env, exports, 2, properties); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
