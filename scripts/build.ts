// build.ts - Handles building the application with version information

import * as path from "@std/path";
import { VERSION } from "../version.ts";

// Get the version from environment or use date-based versioning
const getVersion = () => {
  // Use environment variable if provided
  const envVersion = Deno.env.get("DOCKER_CONTROL_VERSION");
  if (envVersion) {
    return envVersion;
  }

  return VERSION;
};

// Build the application with the version baked in
async function build() {
  console.log("Building Docker Control...");

  // Determine version
  const version = getVersion();
  console.log(`Using version: ${version}`);

  // Create bin directory if it doesn't exist
  try {
    await Deno.mkdir("bin", { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
      console.error("Failed to create bin directory:", error);
      Deno.exit(1);
    }
  }

  const versionFilePath = path.join(Deno.cwd(), "version.ts");
  const versionFileContent = await Deno.readTextFile(versionFilePath);

  // Create temporary file with updated version
  const tempVersionFilePath = path.join(Deno.cwd(), "version.temp.ts");
  const updatedContent = versionFileContent.replace(
    /export const VERSION = ".*";/,
    `export const VERSION = "${version}";`,
  );

  await Deno.writeTextFile(tempVersionFilePath, updatedContent);

  try {
    // Compile the application using the temporary version file
    const compileProcess = new Deno.Command("deno", {
      args: [
        "compile",
        "--allow-env",
        "--allow-net",
        "--allow-read",
        "--allow-sys",
        "--allow-write",
        "-o",
        path.join(Deno.cwd(), "bin", "docker-control"),
        path.join(Deno.cwd(), "main.ts"),
      ],
      stdout: "inherit",
      stderr: "inherit",
    });

    const { code } = await compileProcess.output();

    if (code !== 0) {
      console.error("Build failed with exit code:", code);
      Deno.exit(code);
    }

    console.log(`Successfully built Docker Control v${version}`);
    console.log("Binary location: ./bin/docker-control");
  } finally {
    // Clean up temporary version file
    try {
      await Deno.remove(tempVersionFilePath);
    } catch (error) {
      console.error("Failed to clean up temporary file:", error);
    }
  }
}

// Run the build process
await build();
