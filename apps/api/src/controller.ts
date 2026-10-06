import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  Res,
  HttpCode,
  Inject,
} from "@nestjs/common";
import type { Response } from "express";
import { PlatformService } from "./service";
import { SecurityService, type OperatorRequest } from "./security";
@Controller()
export class ApiController {
  constructor(
    @Inject(PlatformService) private readonly service: PlatformService,
    @Inject(SecurityService) private readonly security: SecurityService,
  ) {}
  @Get("health/live") live() {
    return { status: "live" };
  }
  @Get("health/ready") ready() {
    return this.service.ready();
  }
  @Post("auth/login") @HttpCode(200) login(
    @Body() b: unknown,
    @Req() r: OperatorRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.security.login(b, r, response);
  }
  @Get("auth/session") session(@Req() r: OperatorRequest) {
    return { actorId: r.operator.id, csrfToken: r.operator.csrf };
  }
  @Post("auth/logout") @HttpCode(200) logout(
    @Body() body: unknown,
    @Req() req: OperatorRequest,
    @Res({ passthrough: true }) r: Response,
  ) {
    return this.security.logout(req, r, body);
  }
  @Get("capabilities") capabilities() {
    return this.service.capabilities();
  }
  @Get("openapi.json") openapi() {
    return this.service.openapi();
  }
  @Get("dashboard") dashboard() {
    return this.service.dashboard();
  }
  @Post("projects") createProject(
    @Body() b: unknown,
    @Req() r: OperatorRequest,
  ) {
    return this.service.createProject(b, r);
  }
  @Get("projects") projects(@Query() q: unknown) {
    return this.service.projects(q);
  }
  @Get("projects/:id") project(@Param("id") id: string) {
    return this.service.project(id);
  }
  @Post("projects/:id/tasks") createTask(
    @Param("id") id: string,
    @Body() b: unknown,
    @Req() r: OperatorRequest,
  ) {
    return this.service.createTask(id, b, r);
  }
  @Get("projects/:id/tasks") tasks(
    @Param("id") id: string,
    @Query() q: unknown,
  ) {
    return this.service.tasks(id, q);
  }
  @Get("tasks/:id") task(@Param("id") id: string) {
    return this.service.task(id);
  }
  @Get("tasks/:id/runs") runs(@Param("id") id: string) {
    return this.service.runs(id);
  }
  @Get("tasks/:id/events") events(
    @Param("id") id: string,
    @Query() q: unknown,
  ) {
    return this.service.events(id, q);
  }
  @Post("tasks/:id/plan") @HttpCode(202) plan(
    @Param("id") id: string,
    @Body() b: unknown,
    @Req() r: OperatorRequest,
  ) {
    return this.service.start(id, b, r, "PLAN");
  }
  @Post("tasks/:id/retry") @HttpCode(202) retry(
    @Param("id") id: string,
    @Body() b: unknown,
    @Req() r: OperatorRequest,
  ) {
    return this.service.start(id, b, r, "RETRY");
  }
  @Post("tasks/:id/cancel") @HttpCode(200) cancel(
    @Param("id") id: string,
    @Body() b: unknown,
    @Req() r: OperatorRequest,
  ) {
    return this.service.cancel(id, b, r);
  }
  @Post("approvals/:id/approve") @HttpCode(200) approve(
    @Param("id") id: string,
    @Body() b: unknown,
    @Req() r: OperatorRequest,
  ) {
    return this.service.decide(id, b, r, "APPROVE");
  }
  @Post("approvals/:id/request-changes") @HttpCode(202) changes(
    @Param("id") id: string,
    @Body() b: unknown,
    @Req() r: OperatorRequest,
  ) {
    return this.service.decide(id, b, r, "CHANGES");
  }
  @Post("approvals/:id/reject") @HttpCode(200) reject(
    @Param("id") id: string,
    @Body() b: unknown,
    @Req() r: OperatorRequest,
  ) {
    return this.service.decide(id, b, r, "REJECT");
  }
}
