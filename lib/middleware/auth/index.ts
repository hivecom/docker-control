import { Context, Next } from "hono";

// Authentication Middleware
export const middlewareAuth = async (c: Context, next: Next) => {
  const authHeader = c.req.header("Authorization");
  if (authHeader !== `Bearer ${Deno.env.get("DOCKER_CONTROL_TOKEN")}`) {
    return c.text("Unauthorized", 401);
  }

  await next();
};
