import { Global, Module } from '@nestjs/common';
import { CourierService } from './couriers/courier.service.js';
import { PaymentsService } from './payments/payments.service.js';
import { AgeVerificationService } from './age-verification/age-verification.service.js';

/**
 * The outside services an online order leans on: a courier, a card processor
 * and an age check. Global because checkout, the order queue and the courier's
 * webhook all need the same instances -- one idea of "is delivery live here".
 */
@Global()
@Module({
  providers: [CourierService, PaymentsService, AgeVerificationService],
  exports: [CourierService, PaymentsService, AgeVerificationService],
})
export class ProvidersModule {}
