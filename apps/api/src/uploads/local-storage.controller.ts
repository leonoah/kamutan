import { Controller, HttpCode, HttpStatus, Inject, Param, Put, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/decorators';
import { ApiException } from '../common/api-exception';
import { TooLargeError } from './inspect';
import { LocalObjectStorage } from './storage/local.storage';
import { OBJECT_STORAGE } from './storage/object-storage';

/**
 * DEV/TEST ONLY (STORAGE_DRIVER=local): receives raw upload bytes for a signed
 * local upload URL. Authenticated by the HMAC token in the path, like a
 * Supabase signed upload URL. Not registered when STORAGE_DRIVER=supabase.
 */
@ApiExcludeController()
@Public()
@Controller({ path: 'local-storage', version: '1' })
export class LocalStorageController {
  constructor(@Inject(OBJECT_STORAGE) private readonly storage: LocalObjectStorage) {}

  @Put(':token')
  @HttpCode(200)
  async put(@Param('token') token: string, @Req() req: Request): Promise<{ ok: true; size: number }> {
    const grant = this.storage.verifyGrant(token);
    if (!grant) throw new ApiException(HttpStatus.FORBIDDEN, 'forbidden', 'invalid or expired upload url');
    try {
      const size = await this.storage.write(grant.path, req, grant.max);
      return { ok: true, size };
    } catch (err) {
      if (err instanceof TooLargeError) {
        throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, 'payload_too_large', 'file exceeds limit');
      }
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ApiException(HttpStatus.CONFLICT, 'conflict', 'upload already in progress');
      }
      throw err;
    }
  }
}
