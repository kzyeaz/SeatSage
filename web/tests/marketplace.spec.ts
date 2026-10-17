import { test, expect } from "@playwright/test";

test("organizer publishes, fan discovers and books, sales update", async ({
  page,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your next “I was there.”" }),
  ).toBeVisible();
  await expect(page.locator(".event-card").first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("home.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();

  await page
    .getByRole("button", { name: "Save Jazz in the Velvet Room", exact: true })
    .click();
  await page.getByRole("button", { name: /^Saved/ }).click();
  await expect(page.locator(".event-card")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Jazz in the Velvet Room" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "For organizers" }).click();
  await page.getByRole("button", { name: "Create an event" }).click();
  const title = `Test night ${testInfo.project.name} ${Date.now()}`;
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Event name").fill(title);
  await dialog.getByLabel("Venue", { exact: true }).fill("The Demo Room");
  await dialog
    .getByLabel("Date & time", { exact: false })
    .fill("2030-11-18T19:00");
  await dialog
    .getByLabel("About the event")
    .fill(
      "An unforgettable demo evening with live music and a room full of good company.",
    );
  await dialog.getByRole("button", { name: "Publish demo event" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Back to exploring" }).click();
  await page.getByRole("textbox", { name: "Search events" }).fill(title);
  await expect(page.locator(".event-card")).toHaveCount(1);
  await page
    .getByRole("button", { name: `View ${title}`, exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Seat C1, Standard, $50, available",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "Seat C2, Standard, $50, available",
      exact: true,
    })
    .click();
  await page.screenshot({
    path: testInfo.outputPath("seats.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Reserve my seats" }).click();
  await expect(
    page.getByText("Your seats are reserved", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm demo booking" }),
  ).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Confirm demo booking" }).click();
  await expect(
    page.getByRole("heading", { name: "A great night, secured." }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("$108.00", { exact: true }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download demo ticket" }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/^SS-.*\.txt$/);
  await page.getByRole("button", { name: "Go to my tickets" }).click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your next “I was there.”" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "My tickets", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "For organizers" }).click();
  const row = page.getByRole("row").filter({ hasText: title });
  await expect(row).toContainText("2 / 72");
  await expect(row).toContainText("$100");
  expect(browserErrors).toEqual([]);
});
