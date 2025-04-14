// Function to communicate with Docker socket using Deno APIs
export async function querySocket<T>(
  socket: string,
  path: string,
  method = "GET",
  options: { expectEmptyResponse?: boolean; rawResponse?: boolean } = {}
): Promise<T> {
  // Connect to the Unix socket
  const conn = await Deno.connect({ path: socket, transport: "unix" });

  // Prepare HTTP request to the Docker API
  const request = `${method} /v1.41${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`;

  // Send the request
  const encoder = new TextEncoder();
  await conn.write(encoder.encode(request));

  // Read the response
  const decoder = new TextDecoder();

  // Buffer to accumulate data
  let buffer = new Uint8Array(0);
  const tempBuf = new Uint8Array(4096);

  // Read data in chunks until connection closes
  let n: number | null;
  while ((n = await conn.read(tempBuf)) !== null) {
    const newBuffer = new Uint8Array(buffer.length + n);
    newBuffer.set(buffer);
    newBuffer.set(tempBuf.subarray(0, n), buffer.length);
    buffer = newBuffer;
  }

  conn.close();

  if (buffer.length === 0) {
    throw new Error("Failed to read from Docker socket");
  }

  // Parse the HTTP response
  const response = decoder.decode(buffer);

  // Split headers and body
  const parts = response.split("\r\n\r\n");
  if (parts.length < 2) {
    throw new Error("Invalid response from Docker API");
  }

  const headers = parts[0];
  let body = parts.slice(1).join("\r\n\r\n");

  // Check if this is a 204 No Content or similar response
  if (options.expectEmptyResponse || headers.includes("HTTP/1.1 204")) {
    return {} as T;
  }

  // Handle chunked encoding
  if (headers.includes("Transfer-Encoding: chunked")) {
    try {
      // Extract the JSON part from chunked encoding
      body = parseChunkedBody(body);
    } catch (e) {
      console.error("Error parsing chunked response:", e);
      throw new Error("Failed to parse chunked response");
    }
  }

  // If rawResponse is true, return the raw body text without JSON parsing
  if (options.rawResponse) {
    return body as unknown as T;
  }

  // Parse the JSON body if it's not empty
  try {
    if (body.trim() === "") {
      return {} as T;
    }

    // Find the start of valid JSON
    const jsonStartIndex =
      body.indexOf("{") >= 0
        ? Math.min(
            body.indexOf("{"),
            body.indexOf("[") >= 0 ? body.indexOf("[") : Infinity
          )
        : body.indexOf("[");

    if (jsonStartIndex >= 0) {
      body = body.substring(jsonStartIndex);
    }

    return JSON.parse(body) as T;
  } catch (e) {
    console.error("Error parsing JSON:", e, "Body:", body);
    throw e; // Re-throw the original error for better debugging
  }
}

// Helper function to parse chunked HTTP response body
function parseChunkedBody(chunkedBody: string): string {
  let result = "";
  let currentPos = 0;

  while (currentPos < chunkedBody.length) {
    // Find the end of the chunk size line
    const chunkSizeEnd = chunkedBody.indexOf("\r\n", currentPos);
    if (chunkSizeEnd === -1) break;

    // Parse the chunk size (hex)
    const chunkSizeHex = chunkedBody.substring(currentPos, chunkSizeEnd);
    const chunkSize = parseInt(chunkSizeHex, 16);

    // If chunk size is 0, we've reached the end
    if (chunkSize === 0) break;

    // Extract the chunk data
    const chunkStart = chunkSizeEnd + 2; // Skip \r\n
    const chunkEnd = chunkStart + chunkSize;

    if (chunkEnd <= chunkedBody.length) {
      result += chunkedBody.substring(chunkStart, chunkEnd);
      currentPos = chunkEnd + 2; // Skip the trailing \r\n
    } else {
      // If we can't extract the full chunk, break to avoid infinite loop
      break;
    }
  }

  return result;
}
