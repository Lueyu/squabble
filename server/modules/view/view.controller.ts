/**
 * View controller (SPA fallback).
 *
 * Serves the server-rendered HTML shell for the single-page application. It must be
 * registered last in `AppModule` so it does not shadow any `/api` routes; it catches
 * the root `/` and all unmatched paths (`*`) and renders `index.hbs`, injecting the
 * platform data the client needs at bootstrap.
 */
import { Controller, Get, Render, Req } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Renders the SPA entry page. No business logic; purely a view route.
 */
@Controller()
export class ViewController {
  /**
   * Renders the `index` view for the app root and any non-API fallback path.
   *
   * @param req Express request; provides `__platform_data__` injected by the
   *            platform middleware.
   * @returns Template locals containing the serialized platform info.
   */
  @Get(['/', '*'])
  @Render('index')
  async render(@Req() req: Request): Promise<{ __platform__: string }> {
    // Custom render params may be attached here.
    const platformData = req.__platform_data__ ?? {};
    return {
      // Required by the client to read platform info at bootstrap; do not remove.
      __platform__: JSON.stringify(platformData),
    };
  }
}
