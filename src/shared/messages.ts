// Popup/Background → Content Script
export type ToggleTranslateMsg = { type: 'TOGGLE_TRANSLATE' };
export type ToggleTranslateResponse = {
  action: 'started' | 'cancelled' | 'toggled_visible' | 'toggled_hidden' | 'busy';
};

export type StartTranslateIfIdleMsg = { type: 'START_TRANSLATE_IF_IDLE' };
export type StartTranslateIfIdleResponse = {
  started: boolean;
};

// Content Script → Background
export type TranslateBatchMsg = {
  type: 'TRANSLATE_BATCH';
  batchId: string;
  texts: string[];
  totalBatches: number;
};

export type ReportTranslateStatusMsg = {
  type: 'REPORT_TRANSLATE_STATUS';
  status: 'translating' | 'done' | 'error';
  progress?: { completed: number; total: number };
  error?: string;
};

export type CancelTranslateMsg = { type: 'CANCEL_TRANSLATE' };

// Background → sendResponse
export type TranslateBatchResult = {
  batchId: string;
  translations: string[];
  error?: string;
};

// Background → Popup (broadcast)
export type TranslateStatusMsg = {
  type: 'TRANSLATE_STATUS';
  status: 'translating' | 'done' | 'cancelled' | 'error';
  progress?: { completed: number; total: number };
  error?: string;
};

// Popup → Background
export type QueryStatusMsg = { type: 'QUERY_STATUS'; tabId: number };

// Popup → Background
export type TestConnectionMsg = { type: 'TEST_CONNECTION' };
export type TestConnectionResult = {
  success: boolean;
  error?: string;
};

// Content Script → Background (keepalive)
export type KeepaliveMsg = { type: 'KEEPALIVE' };

export type MessageFromContentScript =
  | TranslateBatchMsg
  | ReportTranslateStatusMsg
  | CancelTranslateMsg
  | KeepaliveMsg;

export type MessageFromPopup =
  | QueryStatusMsg
  | TestConnectionMsg;

export type MessageToContentScript =
  | ToggleTranslateMsg
  | StartTranslateIfIdleMsg;
