// =====================================================================
//  DTO : EnvoyerOtpDto / VerifierOtpDto
// =====================================================================

import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, Length, Matches } from 'class-validator';

export enum OtpPurpose {
  LOGIN = 'LOGIN',
  REGISTER = 'REGISTER',
  RESET_PIN = 'RESET_PIN',
}

export class EnvoyerOtpDto {
  @ApiProperty({ example: '+2250709123456' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'Format invalide. Exemple : +2250709123456',
  })
  phone: string;

  @ApiProperty({ enum: OtpPurpose, example: OtpPurpose.LOGIN })
  @IsEnum(OtpPurpose, { message: 'Purpose invalide' })
  purpose: OtpPurpose;
}

export class VerifierOtpDto {
  @ApiProperty({ example: '+2250709123456' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'Format invalide. Exemple : +2250709123456',
  })
  phone: string;

  @ApiProperty({ example: '482916', description: 'Code à 6 chiffres' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'Le code OTP doit avoir exactement 6 chiffres' })
  @Matches(/^\d{6}$/, { message: 'Le code OTP doit contenir uniquement des chiffres' })
  code: string;

  @ApiProperty({ enum: OtpPurpose, example: OtpPurpose.LOGIN })
  @IsEnum(OtpPurpose, { message: 'Purpose invalide' })
  purpose: OtpPurpose;
}
