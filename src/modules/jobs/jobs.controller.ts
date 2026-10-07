import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Principal } from '../../common/auth/principal.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../common/decorators/auth.decorators.js';
import type { AppConfig } from '../../config/configuration.js';
import {
  CreateJobDto,
  DownloadDto,
  ExecutionDto,
  ExecutionPageDto,
  JobDto,
  JobTypeDto,
  ListExecutionsQueryDto,
  RunJobDto,
  StartImportDto,
  UpdateJobDto,
} from './dto/jobs.dto.js';
import { JobsService } from './jobs.service.js';

/** Hard cap for multer; IMPORT_MAX_MB is enforced by the service. */
const MULTER_LIMIT = 200 * 1024 * 1024;

@ApiTags('admin · jobs')
@Controller('admin')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get('jobs/types')
  @RequirePermissions('jobs:read')
  @ApiOperation({ summary: 'Job types: exports, imports, reindexing…' })
  @ApiOkResponse({ type: [JobTypeDto] })
  types() {
    return this.jobs.types();
  }

  @Get('jobs')
  @RequirePermissions('jobs:read')
  @ApiOkResponse({ type: [JobDto] })
  list() {
    return this.jobs.list();
  }

  @Post('jobs')
  @RequirePermissions('jobs:write')
  @ApiOperation({
    summary:
      'Define a job (a type with parameters, on a cron schedule or on demand)',
  })
  @ApiCreatedResponse({ type: JobDto })
  create(@Body() dto: CreateJobDto, @CurrentPrincipal() p: Principal) {
    return this.jobs.create(dto, p);
  }

  @Get('jobs/:id')
  @RequirePermissions('jobs:read')
  @ApiOkResponse({ type: JobDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(id);
  }

  @Patch('jobs/:id')
  @RequirePermissions('jobs:write')
  @ApiOkResponse({ type: JobDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateJobDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.jobs.update(id, dto, p);
  }

  @Delete('jobs/:id')
  @RequirePermissions('jobs:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({
    description: 'Deleted; its execution history is kept',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.jobs.remove(id, p);
  }

  @Post('jobs/:id/run')
  @RequirePermissions('jobs:write')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Run a defined job now (409 while a run is open)' })
  @ApiAcceptedResponse({ type: ExecutionDto })
  run(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.jobs.run(id, p);
  }

  @Post('job-executions')
  @RequirePermissions('jobs:write')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Run a job type once (exports, reindexing); follow it with GET …/:id',
  })
  @ApiAcceptedResponse({ type: ExecutionDto })
  start(@Body() dto: RunJobDto, @CurrentPrincipal() p: Principal) {
    return this.jobs.start(dto, p);
  }

  @Post('imports')
  @RequirePermissions('jobs:write')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MULTER_LIMIT, files: 1 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'type'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'UTF-8 CSV with a header row',
        },
        type: { type: 'string', example: 'import.prices' },
        params: { type: 'string', example: '{"priceBook":"us-retail"}' },
      },
    },
  })
  @ApiOperation({
    summary:
      'Import a CSV file (runs in the background; row errors are reported on the execution)',
  })
  @ApiAcceptedResponse({ type: ExecutionDto })
  import(
    @UploadedFile()
    file: { buffer: Buffer; originalname?: string; size: number } | undefined,
    @Body() body: StartImportDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.jobs.startImport(
      file,
      body,
      p,
      this.config.get('jobs', { infer: true }).importMaxBytes,
    );
  }

  @Get('job-executions')
  @RequirePermissions('jobs:read')
  @ApiOkResponse({ type: ExecutionPageDto })
  executions(@Query() q: ListExecutionsQueryDto) {
    return this.jobs.executions(q);
  }

  @Get('job-executions/:id')
  @RequirePermissions('jobs:read')
  @ApiOkResponse({ type: ExecutionDto })
  execution(@Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.execution(id);
  }

  @Post('job-executions/:id/cancel')
  @RequirePermissions('jobs:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel: a queued run stops at once, a running one at its next checkpoint',
  })
  @ApiOkResponse({ type: ExecutionDto })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.jobs.cancel(id, p);
  }

  @Get('job-executions/:id/download')
  @RequirePermissions('jobs:read')
  @ApiOperation({
    summary:
      'A short-lived link to the file an export produced (kept JOBS_FILE_RETENTION_DAYS)',
  })
  @ApiOkResponse({ type: DownloadDto })
  download(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.jobs.download(id, p);
  }
}
