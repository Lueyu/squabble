import { Global, Module } from '@nestjs/common';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';
import { TelemetryCaptureService } from './telemetry-capture.service';

@Global()
@Module({ controllers: [TelemetryController], providers: [TelemetryService, TelemetryCaptureService], exports: [TelemetryCaptureService] })
export class TelemetryModule {}
