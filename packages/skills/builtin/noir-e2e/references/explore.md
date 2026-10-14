# Explore the running app

Drive the app toward a goal without a test file, to check a change or find a
locator before writing one.

## How

Use the host's own live surface: a browser automation tool, Playwright MCP, or
the running app in headed mode. Observe the screen, read the accessible names,
then act.

## Steps

1. Start the app the way the project starts it.
2. Open the target screen and observe its roles, labels, and text.
3. Try the flow by hand through the live surface, one goal at a time.
4. For each step you got working, write down the exact locator and assertion
   that pin it, then turn the session into a real test.

## Budget

Exploring is for discovery, not for shipping evidence. Once you have the
locators and the flow, write the deterministic test and register it. The
explore session itself is not the artifact.
