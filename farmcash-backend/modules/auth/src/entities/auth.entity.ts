// =====================================================================
//  ENTITY : OtpEntity
//  Représentation TypeScript de la table "otps".
//  Stocke les codes OTP envoyés par SMS (hashés, pas en clair).
// =====================================================================

export class OtpEntity {
  id: string;
  phone: string;
  code_hash: string;  // Le code est TOUJOURS stocké hashé (bcrypt)
  purpose: string;    // 'LOGIN' | 'REGISTER' | 'RESET_PIN'
  is_used: boolean;
  expires_at: Date;
  created_at: Date;
}

// =====================================================================
//  ENTITY : RefreshTokenEntity
//  Représentation TypeScript de la table "refresh_tokens".
//  Permet de renouveler le JWT sans retaper le PIN (valable 7 jours).
// =====================================================================

export class RefreshTokenEntity {
  id: string;
  user_id: string;
  token_hash: string;   // Hash du token (jamais le token brut en DB)
  device_info?: string | null;
  ip_address?: string | null;
  expires_at: Date;
  revoked_at?: Date | null;
  created_at: Date;
}

// =====================================================================
//  ENTITY : DeviceTokenEntity
//  Représentation TypeScript de la table "device_tokens".
//  Stocke les tokens FCM Firebase pour les notifications push.
// =====================================================================

export class DeviceTokenEntity {
  id: string;
  user_id: string;
  fcm_token: string;         // Token Firebase Cloud Messaging
  platform: string;           // 'android' ou 'ios'
  is_active: boolean;
  created_at: Date;
}

// =====================================================================
//  ENTITY : UserDocumentEntity
//  Représentation TypeScript de la table "user_documents".
//  Documents KYC uploadés pour vérification d'identité.
// =====================================================================

export class UserDocumentEntity {
  id: string;
  user_id: string;
  doc_type: string;    // 'CNI' | 'PASSEPORT' | 'RCCM'
  doc_url: string;     // URL du fichier sur le stockage cloud
  status: string;      // 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED'
  rejection_reason?: string | null;
  verified_by?: string | null;
  verified_at?: Date | null;
  expires_at?: Date | null;
  created_at: Date;
}
