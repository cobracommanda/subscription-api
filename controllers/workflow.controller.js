// import dayjs from "dayjs";
// import { createRequire } from "module";
// const require = createRequire(import.meta.url);
// const { serve } = require("@upstash/workflow/express");
// import Subscription from "../models/subscription.model.js";
// import { sendReminderEmail } from "../utils/send-email.js";

// const REMINDERS = [7, 5, 2, 1];

// export const sendReminders = serve(async (context) => {
//   const { subscriptionId } = context.requestPayload;
//   const subscription = await fetchSubscription(context, subscriptionId);

//   if (!subscription || subscription.status !== "active") return;

//   const renewalDate = dayjs(subscription.renewalDate);

//   if (renewalDate.isBefore(dayjs())) {
//     console.log(
//       `Renewal date has passed for subscription ${subscriptionId}. Stopping workflow.`
//     );
//     return;
//   }

//   for (const daysBefore of REMINDERS) {
//     const reminderDate = renewalDate.subtract(daysBefore, "day");

//     if (reminderDate.isAfter(dayjs())) {
//       await sleepUntilReminder(
//         context,
//         `Reminder ${daysBefore} days before`,
//         reminderDate
//       );
//     }

//     if (dayjs().isSame(reminderDate, "day")) {
//       await triggerReminder(
//         context,
//         `${daysBefore} days before reminder`,
//         subscription
//       );
//     }
//   }
// });

// const fetchSubscription = async (context, subscriptionId) => {
//   return await context.run("get subscription", async () => {
//     return Subscription.findById(subscriptionId).populate("user", "name email");
//   });
// };

// const sleepUntilReminder = async (context, label, date) => {
//   console.log(`Sleeping until ${label} reminder at ${date}`);
//   await context.sleepUntil(label, date.toDate());
// };

// const triggerReminder = async (context, label, subscription) => {
//   return await context.run(label, async () => {
//     console.log(`Triggering ${label} reminder`);

//     await sendReminderEmail({
//       to: subscription.user.email,
//       type: label,
//       subscription,
//     });
//   });
// };

import dayjs from "dayjs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { serve } = require("@upstash/workflow/express");
import Subscription from "../models/subscription.model.js";
import { sendReminderEmail } from "../utils/send-email.js";

const REMINDERS = [7, 5, 2, 1];

export const sendReminders = serve(async (context) => {
  const { subscriptionId } = context.requestPayload;

  if (!subscriptionId) {
    console.error("No subscriptionId provided in requestPayload");
    return;
  }

  // initial fetch
  const subscription = await fetchSubscription(context, subscriptionId);

  if (!subscription) {
    console.error(
      `Subscription ${subscriptionId} not found. Aborting workflow.`
    );
    return;
  }

  if (subscription.status !== "active") {
    console.log(
      `Subscription ${subscriptionId} status is not active (${subscription.status}). Exiting.`
    );
    return;
  }

  const renewalDate = dayjs(subscription.renewalDate);
  const now = dayjs();

  if (!renewalDate.isValid()) {
    console.error(
      `Invalid renewalDate for subscription ${subscriptionId}:`,
      subscription.renewalDate
    );
    return;
  }

  if (renewalDate.isBefore(now, "day")) {
    console.log(
      `Renewal date has passed for subscription ${subscriptionId} (${renewalDate.toString()}). Stopping workflow.`
    );
    return;
  }

  // Build reminder objects and sort ascending (earliest first)
  const reminders = REMINDERS.map((daysBefore) => {
    return {
      daysBefore,
      reminderDate: renewalDate.subtract(daysBefore, "day"),
    };
  }).sort((a, b) => a.reminderDate.valueOf() - b.reminderDate.valueOf());

  for (const { daysBefore, reminderDate } of reminders) {
    const reminderLabel = `${daysBefore} days before reminder`;
    // If reminder date is in the past (strictly before today), skip it
    if (reminderDate.isBefore(dayjs(), "day")) {
      console.log(
        `Skipping ${reminderLabel} (date ${reminderDate.toString()}) — it's in the past.`
      );
      continue;
    }

    // If reminder is strictly in the future, sleep until it
    if (reminderDate.isAfter(dayjs())) {
      console.log(
        `Sleeping until ${reminderLabel} at ${reminderDate.toString()}`
      );
      try {
        await sleepUntilReminder(
          context,
          `Reminder ${daysBefore} days before`,
          reminderDate
        );
      } catch (err) {
        console.error(`sleepUntil failed for ${reminderLabel}:`, err);
        // Continue — attempt to trigger, since we may have woken irregularly
      }
    } else {
      // reminderDate is same day as now — we will trigger immediately
      console.log(
        `${reminderLabel} is today (${reminderDate.toString()}). Triggering without sleep.`
      );
    }

    // After waking (or if same-day), trigger the reminder for this subscription entry.
    // Re-fetch subscription to ensure we have up-to-date info.
    try {
      const freshSub = await fetchSubscription(context, subscriptionId);

      if (!freshSub) {
        console.error(
          `Subscription ${subscriptionId} not found when attempting to trigger ${reminderLabel}.`
        );
        continue;
      }

      if (!freshSub.user || !freshSub.user.email) {
        console.error(
          `Missing user/email on subscription ${subscriptionId} when triggering ${reminderLabel}.`
        );
        continue;
      }

      console.log(
        `Triggering ${reminderLabel} for ${freshSub.user.email} (subscription ${subscriptionId})`
      );
      // IMPORTANT: we call the actual email sending directly (no context.run here).
      // This avoids attempting to append child steps to a workflow that Upstash may have cancelled.
      await sendReminderWithRetries(
        freshSub.user.email,
        `${daysBefore} days before reminder`,
        freshSub
      );
      console.log(
        `Finished triggering ${reminderLabel} for ${freshSub.user.email}`
      );
    } catch (err) {
      console.error(
        `Error while triggering ${reminderLabel} for subscription ${subscriptionId}:`,
        err
      );
    }
  }

  console.log(`All reminders processed for subscription ${subscriptionId}`);
});

const fetchSubscription = async (context, subscriptionId) => {
  return await context.run("get subscription", async () => {
    // note: adjust projection as needed, ensure user.email is present
    return Subscription.findById(subscriptionId).populate("user", "name email");
  });
};

const sleepUntilReminder = async (context, label, date) => {
  // Ensure date is a Date object (context.sleepUntil expects Date)
  const when = date.toDate ? date.toDate() : new Date(date);
  console.log(`sleepUntil: ${label} -> ${new Date(when).toISOString()}`);
  await context.sleepUntil(label, when);
};

/**
 * Send email with a small retry loop for transient failures.
 * Avoids context.run to prevent "cannot append to cancelled workflow" errors.
 */
const sendReminderWithRetries = async (
  to,
  type,
  subscription,
  maxAttempts = 3
) => {
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      console.log(`sendReminder attempt ${attempt} -> ${to} (${type})`);
      await sendReminderEmail({
        to,
        type,
        subscription,
      });
      console.log(`Email sent to ${to} on attempt ${attempt}`);
      return;
    } catch (err) {
      console.error(`sendReminder attempt ${attempt} failed:`, err);

      // simple exponential backoff
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 10000);
      await new Promise((res) => setTimeout(res, backoffMs));
    }
  }

  // if we get here, all attempts failed
  console.error(
    `All ${maxAttempts} attempts to send reminder to ${to} failed. Last error:`,
    lastErr
  );
  // Do NOT rethrow here unless you want the workflow to be marked failed. Logging is safer so a cancelled workflow
  // or transient QStash issues don't leave you with unhandled exceptions.
  return;
};
