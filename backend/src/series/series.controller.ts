import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { CreateSeriesDto, EndSeriesDto, ExtendSeriesDto, ListSeriesDto, UpdateSeriesDto } from './dto';
import { SeriesService } from './series.service';

@Controller('series')
@UseGuards(JwtAuthGuard)
export class SeriesController {
  constructor(private readonly series: SeriesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListSeriesDto) {
    return this.series.list(user.tenantId, query);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSeriesDto) {
    return this.series.create(user, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.series.get(user.tenantId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSeriesDto,
  ) {
    return this.series.update(user.tenantId, id, dto);
  }

  @Post(':id/extend')
  extend(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExtendSeriesDto,
  ) {
    return this.series.extend(user.tenantId, id, dto);
  }

  @Post(':id/end')
  end(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EndSeriesDto,
  ) {
    return this.series.end(user.tenantId, id, dto);
  }
}
