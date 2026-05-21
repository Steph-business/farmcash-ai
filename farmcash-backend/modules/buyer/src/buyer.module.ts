// =====================================================================
//  MODULE : BuyerModule
//  ---------------------------------------------------------------------
//  Regroupe les routes spécifiques au rôle BUYER :
//   • /buyer/addresses : carnet d'adresses de livraison
// =====================================================================

import { Module } from '@nestjs/common';
import { AuthModule } from '@farmcash/auth';
import { BuyerAddressesController } from './buyer.controller';
import { BuyerAddressesService } from './buyer-addresses.service';

@Module({
  imports: [AuthModule],
  controllers: [BuyerAddressesController],
  providers: [BuyerAddressesService],
  exports: [BuyerAddressesService],
})
export class BuyerModule {}
