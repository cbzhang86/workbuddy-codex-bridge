// Wire-level constants transcribed from dsh-connect-workbuddy v5.21.3
// (lib/host-heartbeat-*.js) and workbuddy2api. These values are validated by the
// upstream gateway; do NOT "modernise" them casually.
//
// External sources (untrusted data, used as protocol reference only):
//   https://github.com/dingminhua/dsh-connect-workbuddy
//   https://github.com/240xu/workbuddy2api
//   https://opencodex.me/zh-cn/guides/codex-integration/

export const CN_CHAT_BASE = "https://copilot.tencent.com";
export const CN_BILLING_BASE = "https://www.codebuddy.cn";
export const GLOBAL_BASE = "https://www.workbuddy.ai";
export const GLOBAL_CODEBUDDY_BASE = "https://www.codebuddy.ai";

export const CHAT_PATH = "/v2/chat/completions";
export const REFRESH_PATH = "/v2/plugin/auth/token/refresh";
export const GLOBAL_CONFIG_PATH = "/v3/config";
export const LEGACY_CATALOG_PATH = "/v2/enterprises/personal/models";
export const MODEL_BUSY_PATH = "/v2/chat/busy";
export const OAUTH_STATE_PATH = "/v2/plugin/auth/state?platform=workbuddy";
export const OAUTH_TOKEN_PATH = "/v2/plugin/auth/token";
export const OAUTH_ACCOUNT_PATH = "/v2/plugin/login/account";
export const CHECKIN_PATH = "/v2/billing/meter/daily-checkin";

export const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
export const PRODUCT_UA = "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0";
export const APP_CHANNEL_UA = "WorkBuddy/5.8.3";
export const CATALOG_CLI_UA = CLIENT_UA;
export const APP_VERSION = "5.8.3";
export const ATTRIBUTION_CLIENT_NAME = "WorkBuddy";

export const NEUTRAL_SYSTEM = "You are a helpful assistant.";
export const ZERO_WIDTH_SPACE = "\u200B"; // U+200B ZERO WIDTH SPACE
export const DEVICE_ID_NAMESPACE = "dsh-connect-workbuddy/device/v1";
export const ROUTER_MODEL_IDS = new Set(["auto", "default-model"]);

export const UNAPPROVED_CHANNEL_OPENINGS = [
  "you are an ai agent powered by deepseek harness",
  "you are claude code, anthropic's official cli for claude",
];
export const IDENTITY_CLAUSE =
  /(you)(\s+are\s+(?:(?:an?\s+)?[\w-]*\s*agent\s+powered\s+by|interacting\s+with\s+the\s+user\s+through\s+the\s+deepseek\s+harness))/giu;

export const DEFAULT_PORT = 10100;
export const DEFAULT_HOST = "127.0.0.1";
export const OFFICIAL_CODEX_BASE = "https://chatgpt.com/backend-api/codex";
export const MODEL_PREFIX = "wb";

export const INJECT_BEGIN = "# >>> workbuddy-codex-bridge (undo: wb-bridge restore) >>>";
export const INJECT_END = "# <<< workbuddy-codex-bridge <<<";
export const BACKUP_SUFFIX = ".wb-bridge-backup";
export const CATALOG_FILENAME = "workbuddy-catalog.json";

export const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153", "session expired"];
export const CREDIT_MARKERS = [
  "insufficient credit", "积分不足", "额度不足", "余额不足", "积分用完",
  "额度用尽", "没有积分", "quota exceeded", "payment required", "14018",
];
