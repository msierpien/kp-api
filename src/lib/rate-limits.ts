export const RATE_LIMITS = {
  authLogin: {
    max: 5,
    timeWindow: '1 minute',
    groupId: 'auth-login',
  },
  authRefresh: {
    max: 20,
    timeWindow: '1 minute',
    groupId: 'auth-refresh',
  },
  prestashopWebhook: {
    max: 120,
    timeWindow: '1 minute',
    groupId: 'prestashop-webhook',
  },
  adminUpload: {
    max: 20,
    timeWindow: '1 minute',
    groupId: 'admin-upload',
  },
  publicPreviewUpload: {
    max: 10,
    timeWindow: '1 minute',
    groupId: 'public-preview-upload',
  },
  personalizationPreview: {
    max: 30,
    timeWindow: '1 minute',
    groupId: 'personalization-preview',
  },
} as const;
