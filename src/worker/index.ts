import app from "./app";
import { dispatch } from "./services/dispatch";

export default {
  fetch: app.fetch,
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await dispatch(
      env.DB,
      env.LINE_CHANNEL_ACCESS_TOKEN,
      controller.scheduledTime,
    );
  },
} satisfies ExportedHandler<Env>;
