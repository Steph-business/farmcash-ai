// =====================================================================
//  CONTROLLER : InteractionsController
//  ---------------------------------------------------------------------
//  Favoris, avis et médias. Restreint aux rôles qui interagissent
//  réellement avec le marketplace (BUYER, FARMER, COOPERATIVE).
//  TRANSPORTER, EXPORTER, ADMIN n'ont pas accès.
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
import { JwtAuthGuard, Roles, RolesGuard } from '@farmcash/auth';
import { InteractionsService } from './interactions.service';
import {
  AddAvisDto,
  AddFavoriDto,
  AddMediaDto,
  MediaKind,
  UploadMediaDto,
} from './dto/interactions.dto';

@ApiTags('⭐ Interactions (Favoris, Avis, Médias)')
@Controller('marketplace/interactions')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
@Roles('BUYER', 'FARMER', 'COOPERATIVE')
export class InteractionsController {
  constructor(private readonly interactionsService: InteractionsService) {}

  // ----- Favoris -----

  @Get('favoris')
  @ApiOperation({ summary: 'Lister mes annonces favorites' })
  getMesFavoris(@CurrentUser() user: AuthenticatedUser) {
    return this.interactionsService.getMesFavoris(user.sub);
  }

  @Post('favoris/toggle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ajouter ou retirer une annonce des favoris' })
  toggleFavori(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddFavoriDto,
  ) {
    return this.interactionsService.toggleFavori(user.sub, dto);
  }

  // ----- Avis -----

  @Post('avis')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Laisser un avis (exige une commande livrée)" })
  laisserAvis(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddAvisDto,
  ) {
    return this.interactionsService.laisserAvis(user.sub, dto);
  }

  @Delete('avis/:id')
  @ApiOperation({ summary: 'Supprimer mon avis' })
  deleteAvis(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.interactionsService.deleteAvis(user.sub, id);
  }

  // ----- Médias -----

  @Post('medias')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      "Ajouter un média à une annonce, publication coopérative ou lot (ownership requis)",
  })
  addMedia(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddMediaDto,
  ) {
    return this.interactionsService.addMedia(user.sub, user.cooperative_id, dto);
  }

  /**
   * Upload de fichier multipart vers MinIO (compatible S3) avec création
   * automatique de la row `medias`. Le client envoie le binaire dans le
   * champ `file` + les métadonnées `target_type` / `target_id` / `type`
   * en form-data — pas besoin d'orchestrer 2 appels.
   */
  @Post('medias/upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Uploader un fichier (image/vidéo) et créer la row media associée',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'target_type', 'target_id'],
      properties: {
        file: { type: 'string', format: 'binary' },
        target_type: {
          type: 'string',
          enum: ['ANNONCE_VENTE', 'PUBLICATION_COOP', 'LOT'],
        },
        target_id: { type: 'string', format: 'uuid' },
        type: {
          type: 'string',
          enum: ['IMAGE', 'VIDEO', 'DOCUMENT'],
          default: 'IMAGE',
        },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  uploadMedia(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadMediaDto,
  ) {
    return this.interactionsService.uploadMedia(
      user.sub,
      user.cooperative_id,
      file,
      dto.target_type,
      dto.target_id,
      dto.type ?? MediaKind.IMAGE,
    );
  }

  @Delete('medias/:id')
  @ApiOperation({ summary: 'Supprimer un média (ownership requis)' })
  deleteMedia(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.interactionsService.deleteMedia(user.sub, user.cooperative_id, id);
  }
}
