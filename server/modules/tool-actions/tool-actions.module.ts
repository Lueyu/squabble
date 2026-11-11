import { Module } from '@nestjs/common';
import { ToolActionsController } from './tool-actions.controller';
import { TOOL_ACTION_VALIDATION, ToolActionsService } from './tool-actions.service';
import { ToolActionSourceValidation } from './tool-action-source-validation';

@Module({ controllers: [ToolActionsController], providers: [ToolActionsService, ToolActionSourceValidation,
  { provide: TOOL_ACTION_VALIDATION, useExisting: ToolActionSourceValidation }], exports: [ToolActionsService] })
export class ToolActionsModule {}
