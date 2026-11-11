import { Global, Module } from '@nestjs/common';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';
import { TelemetryCaptureService } from './telemetry-capture.service';
import { TelemetryDiagnosticsService } from './telemetry-diagnostics.service';

@Global()
@Module({ controllers: [TelemetryController], providers: [TelemetryService, TelemetryCaptureService, TelemetryDiagnosticsService], exports: [TelemetryCaptureService] })
export class TelemetryModule {}
