import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import {
  PublicShareBoqSchema,
  PublicShareMetaSchema,
  PublicShareOverlaySchema,
  SHARE_STATE_HEADER,
  SHARE_UNAVAILABLE_MESSAGE,
  type ApiError,
} from '@kamutan/contracts';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators';
import { ApiErrors, ApiZodResponse } from '../common/zod-openapi';
import { PublicShareService, ShareRateLimitedError, ShareUnavailableError, type ShareRequestCtx } from './public-share.service';

const ctxOf = (req: Request): ShareRequestCtx => ({ ip: req.ip, userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined });
const INT_RE = /^\d{1,5}$/;

/**
 * Sprint 5 (FR-30, SEC-26–29): PUBLIC, unauthenticated, read-only share API. No Firebase token is read here and a share
 * token never authenticates anything else (AuthGuard answers 403 to a write carrying one). Non-GET methods on
 * /public/** are answered 405 by the middleware in bootstrap.ts before routing. Every response: X-Robots-Tag noindex,
 * Referrer-Policy no-referrer, Cache-Control no-store (bootstrap.ts).
 */
@ApiTags('public-share')
@Public()
@SkipThrottle()
@Controller({ path: 'public/share/:token', version: '1' })
export class PublicShareController {
  constructor(private readonly svc: PublicShareService) {}

  /** 404 unknown / 410 expired|revoked with the SAME body; 429 with Retry-After. Other errors → global filter. */
  private async run<T>(res: Response, fn: () => Promise<T>, send: (v: T) => void): Promise<void> {
    try {
      send(await fn());
    } catch (err) {
      if (err instanceof ShareUnavailableError) {
        if (err.status === 410) res.setHeader(SHARE_STATE_HEADER, err.state);
        res.status(err.status).json({ error: { code: 'share_unavailable', message: SHARE_UNAVAILABLE_MESSAGE, requestId: null } } satisfies ApiError);
        return;
      }
      if (err instanceof ShareRateLimitedError) {
        res.setHeader('Retry-After', String(err.retryAfterSec));
        res.status(429).json({ error: { code: 'rate_limited', message: 'too many requests', requestId: null } } satisfies ApiError);
        return;
      }
      throw err;
    }
  }

  @Get('meta')
  @ApiZodResponse(200, PublicShareMetaSchema)
  @ApiErrors(404, 410, 429)
  async meta(@Param('token') token: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.run(res, () => this.svc.meta(token, ctxOf(req)), (v) => res.status(200).json(v));
  }

  @Get('boq')
  @ApiZodResponse(200, PublicShareBoqSchema)
  @ApiErrors(404, 410, 429)
  async boq(@Param('token') token: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.run(res, () => this.svc.boqView(token, ctxOf(req)), (v) => res.status(200).json(v));
  }

  @Get('sheets/:sheetId/overlay')
  @ApiZodResponse(200, PublicShareOverlaySchema)
  @ApiErrors(404, 410, 429)
  async overlay(@Param('token') token: string, @Param('sheetId') sheetId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.run(res, () => this.svc.overlay(token, sheetId, ctxOf(req)), (v) => res.status(200).json(v));
  }

  /** image/webp, watermark burned in, title block masked (locked version only). */
  @Get('sheets/:sheetId/tiles/:z/:x/:y')
  @ApiErrors(404, 410, 429)
  async tile(
    @Param('token') token: string,
    @Param('sheetId') sheetId: string,
    @Param('z') z: string,
    @Param('x') x: string,
    @Param('y') y: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const yy = y.replace(/\.webp$/, '');
    if (!INT_RE.test(z) || !INT_RE.test(x) || !INT_RE.test(yy) || Number(z) > 19) {
      res.status(404).json({ error: { code: 'not_found', message: 'tile not found', requestId: null } } satisfies ApiError);
      return;
    }
    await this.run(
      res,
      () => this.svc.tile(token, sheetId, Number(z), Number(x), Number(yy), ctxOf(req)),
      (buf) => {
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Content-Length', String(buf.length));
        res.status(200).end(buf);
      },
    );
  }

  /** 302 → 2-minute signed URL of the per-link watermarked marked PDF (only when allowPdfDownload; 409 while pending). */
  @Get('pdf')
  @ApiErrors(302, 404, 409, 410, 429)
  async pdf(@Param('token') token: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.run(res, () => this.svc.pdf(token, ctxOf(req)), (v) => res.redirect(302, v.url));
  }
}
