// =====================================================================
//  PAYMENT_PROVIDER_TOKEN
//  ---------------------------------------------------------------------
//  Token DI utilisé pour binder dynamiquement l'implémentation
//  PaymentProvider (mock en dev, OrangeMoneyProvider / MTNMoMoProvider /
//  WaveProvider en prod) au runtime via FinanceModule.
//
//  Extracted dans son propre fichier pour éviter une dépendance
//  circulaire entre FinanceModule (qui importe FinanceService) et
//  FinanceService (qui veut juste le token de bind).
// =====================================================================

export const PAYMENT_PROVIDER_TOKEN = 'PAYMENT_PROVIDER';
