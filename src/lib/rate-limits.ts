export const RATE_LIMITS = {
  authLogin: {
    max: 10,
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
  // Agent druku odpytuje co ~10 s (6 hello + 6 claim na minute), wiec 120
  // zostawia szesciokrotny zapas na ponowienia i kilku agentow za jednym NAT-em.
  printAgentPoll: {
    max: 120,
    timeWindow: '1 minute',
    groupId: 'print-agent-poll',
  },
  printAgentReport: {
    max: 120,
    timeWindow: '1 minute',
    groupId: 'print-agent-report',
  },
  printAgentFile: {
    max: 60,
    timeWindow: '1 minute',
    groupId: 'print-agent-file',
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
  /** Odczyt sprawy przez klienta - portal wola to przy kazdym wejsciu. */
  personalizationRead: {
    max: 60,
    timeWindow: '1 minute',
    groupId: 'personalization-read',
  },
  /** Autozapis szkicu chodzi co ~2,5 s, wiec limit musi to miescic z zapasem. */
  personalizationWrite: {
    max: 40,
    timeWindow: '1 minute',
    groupId: 'personalization-write',
  },
  /**
   * Zatwierdzenie kolejkuje pelna paczke renderow (realna praca CPU),
   * a klient robi to raz. Limit jest celowo ciasny.
   */
  personalizationSubmit: {
    max: 5,
    timeWindow: '1 minute',
    groupId: 'personalization-submit',
  },
  /** Wgrywanie wlasnych grafik przez klienta w edytorze. */
  publicAssetUpload: {
    max: 10,
    timeWindow: '1 minute',
    groupId: 'public-asset-upload',
  },
} as const;
