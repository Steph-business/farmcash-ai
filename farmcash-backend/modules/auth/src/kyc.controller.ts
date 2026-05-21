// =====================================================================
//  CONTROLLER : KycController
//  ---------------------------------------------------------------------
//  Routes self-service KYC, ouvertes à tous les rôles authentifiés :
//   • GET    /auth/kyc/my       → liste mes documents
//   • POST   /auth/kyc/upload   → upload + row PENDING
//   • DELETE /auth/kyc/:id      → supprime si PENDING
// =====================================================================

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser } from '@farmcash/shared';
import { JwtAuthGuard } from './guards/jwt.guard';
import { KycService } from './kyc.service';
import { KycDocType, UploadKycDocumentDto } from './dto/kyc.dto';

@ApiTags('🪪 KYC — Justificatifs')
@ApiBearerAuth()
@Controller('auth/kyc')
@UseGuards(JwtAuthGuard)
export class KycController {
  constructor(private readonly kycService: KycService) {}

  @Get('my')
  @ApiOperation({ summary: 'Lister mes documents KYC (tous statuts)' })
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.kycService.listMine(user.sub);
  }

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Uploader un document KYC (image/PDF, max 10 Mo)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'doc_type'],
      properties: {
        file: { type: 'string', format: 'binary' },
        doc_type: {
          type: 'string',
          enum: Object.values(KycDocType),
        },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadKycDocumentDto,
  ) {
    return this.kycService.upload(user.sub, dto.doc_type, file);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Supprimer un document KYC (uniquement si PENDING)' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.kycService.remove(user.sub, id);
  }
}
