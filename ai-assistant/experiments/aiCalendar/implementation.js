/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global ExtensionAPI */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { ExtensionUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionUtils.sys.mjs"
);
var { ExtensionError } = ExtensionUtils;
// Experiment scripts run without window timers.
var { setTimeout, clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

function calModules() {
  const { cal } = ChromeUtils.importESModule(
    "resource:///modules/calendar/calUtils.sys.mjs"
  );
  const { CalEvent } = ChromeUtils.importESModule(
    "resource:///modules/CalEvent.sys.mjs"
  );
  const { CalTodo } = ChromeUtils.importESModule(
    "resource:///modules/CalTodo.sys.mjs"
  );
  return { cal, CalEvent, CalTodo };
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDateTime(cal, value, allDay) {
  if (!value) {
    return null;
  }
  const m = DATE_ONLY.exec(value);
  if (m || allDay) {
    const d = m
      ? { y: +m[1], mo: +m[2] - 1, d: +m[3] }
      : (() => {
          const js = new Date(value);
          return { y: js.getFullYear(), mo: js.getMonth(), d: js.getDate() };
        })();
    const dt = cal.createDateTime();
    dt.resetTo(d.y, d.mo, d.d, 0, 0, 0, cal.dtz.floating);
    dt.isDate = true;
    return dt;
  }
  const js = new Date(value);
  if (isNaN(js)) {
    throw new ExtensionError(`Not a valid date: ${value}`);
  }
  return cal.dtz.jsDateToDateTime(js, cal.dtz.defaultTimezone);
}

function fromDateTime(cal, dt) {
  if (!dt) {
    return null;
  }
  if (dt.isDate) {
    const pad = n => String(n).padStart(2, "0");
    return `${dt.year}-${pad(dt.month + 1)}-${pad(dt.day)}`;
  }
  return cal.dtz.dateTimeToJsDate(dt).toISOString();
}

function convertCalendar(c) {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    readOnly: !!c.readOnly,
    disabled: !!c.getProperty("disabled"),
    supportsEvents: c.getProperty("capabilities.events.supported") !== false,
    supportsTasks: c.getProperty("capabilities.tasks.supported") !== false,
  };
}

function convertItem(cal, item) {
  const out = {
    id: item.id,
    calendarId: item.calendar?.id,
    calendarName: item.calendar?.name,
    title: item.title || "",
    location: item.getProperty("LOCATION") || undefined,
    description: (item.getProperty("DESCRIPTION") || "").slice(0, 2000) || undefined,
  };
  if (item.isTodo()) {
    out.kind = "task";
    if (item.entryDate) {
      out.start = fromDateTime(cal, item.entryDate);
    }
    if (item.dueDate) {
      out.due = fromDateTime(cal, item.dueDate);
    }
    out.completed = !!item.isCompleted;
  } else {
    out.kind = "event";
    out.start = fromDateTime(cal, item.startDate);
    out.end = fromDateTime(cal, item.endDate);
    out.allDay = !!item.startDate?.isDate;
  }
  const parent = item.parentItem || item;
  if (parent.recurrenceInfo) {
    out.recurring = true;
  }
  return out;
}

// Some providers (seen with the JMAP calendar in this build) apply a change
// and notify observers, but their addItem/modifyItem/deleteItem promise never
// settles. Finish on whichever comes first: the call, or the calendar's own
// notice about this item. Otherwise give up after `ms` and say so.
function settle(cal, kind, itemId, operation, ms = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const end = (fn, value) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      try {
        cal.manager.removeCalendarObserver(observer);
      } catch (e) {}
      fn(value);
    };
    const matches = item => item && (item.id == itemId || item.parentItem?.id == itemId);
    const observer = {
      QueryInterface: ChromeUtils.generateQI(["calIObserver"]),
      onStartBatch() {},
      onEndBatch() {},
      onLoad() {},
      onAddItem(item) {
        if (kind == "add" && matches(item)) end(resolve, { item, confirmed: true });
      },
      onModifyItem(newItem) {
        if (kind == "modify" && matches(newItem)) end(resolve, { item: newItem, confirmed: true });
      },
      onDeleteItem(item) {
        if (kind == "delete" && matches(item)) end(resolve, { item, confirmed: true });
      },
      onError() {},
      onPropertyChanged() {},
      onPropertyDeleting() {},
    };
    cal.manager.addCalendarObserver(observer);
    const timer = setTimeout(() => {
      console.warn(`AI assistant: calendar ${kind} of ${itemId} not confirmed within ${ms / 1000} s`);
      end(resolve, { item: null, confirmed: false });
    }, ms);
    Promise.resolve()
      .then(operation)
      .then(
        item => end(resolve, { item, confirmed: true }),
        error => end(reject, error)
      );
  });
}

async function findItem(cal, id, calendarId) {
  let calendars = cal.manager.getCalendars();
  if (calendarId) {
    calendars = calendars.filter(c => c.id == calendarId || c.name == calendarId);
  }
  for (const c of calendars) {
    try {
      const item = await c.getItem(id);
      if (item) {
        return { calendar: c, item };
      }
    } catch (e) {}
  }
  throw new ExtensionError(`No event or task with id ${id}.`);
}

function pickCalendar(cal, calendarId, kind) {
  const calendars = cal.manager.getCalendars();
  if (calendarId) {
    const c = calendars.find(x => x.id == calendarId || x.name == calendarId);
    if (!c) {
      throw new ExtensionError(`No calendar called ${calendarId}.`);
    }
    return c;
  }
  const usable = calendars.filter(
    c =>
      !c.getProperty("disabled") &&
      !c.readOnly &&
      cal.acl.isCalendarWritable(c) &&
      c.getProperty(`capabilities.${kind}.supported`) !== false
  );
  if (!usable.length) {
    throw new ExtensionError("There is no calendar that can take this. Turn on or add a calendar in the Calendar tab first.");
  }
  // Prefer a non-local calendar (e.g. the JMAP/CalDAV one) over "Home".
  return usable.find(c => c.type != "storage") || usable[0];
}

this.aiCalendar = class extends ExtensionCommon.ExtensionAPI {
  getAPI() {
    const api = {
      aiCalendar: {
        async listCalendars() {
          const { cal } = calModules();
          return cal.manager.getCalendars().map(convertCalendar);
        },

        async queryItems(query) {
          const { cal } = calModules();
          const ci = Ci.calICalendar;
          let filter = ci.ITEM_FILTER_CLASS_OCCURRENCES;
          if (query.type == "task") {
            filter |= ci.ITEM_FILTER_TYPE_TODO;
            filter |= query.includeCompleted
              ? ci.ITEM_FILTER_COMPLETED_ALL
              : ci.ITEM_FILTER_COMPLETED_NO;
          } else {
            filter |= ci.ITEM_FILTER_TYPE_EVENT;
          }
          const start = query.rangeStart ? toDateTime(cal, query.rangeStart) : null;
          const end = query.rangeEnd ? toDateTime(cal, query.rangeEnd) : null;
          const limit = query.limit || 100;
          let calendars = cal.manager
            .getCalendars()
            .filter(c => !c.getProperty("disabled"));
          if (query.calendarId) {
            calendars = calendars.filter(
              c => c.id == query.calendarId || c.name == query.calendarId
            );
          }
          const results = [];
          for (const c of calendars) {
            try {
              const items = await c.getItemsAsArray(filter, limit, start, end);
              for (const item of items) {
                results.push(convertItem(cal, item));
              }
            } catch (e) {
              console.error(`AI assistant: reading calendar ${c.name} failed`, e);
            }
          }
          results.sort((a, b) =>
            String(a.start || a.due || "").localeCompare(String(b.start || b.due || ""))
          );
          return results.slice(0, limit);
        },

        async createEvent(event) {
          const { cal, CalEvent } = calModules();
          const calendar = pickCalendar(cal, event.calendarId, "events");
          const item = new CalEvent();
          item.title = event.title;
          const start = toDateTime(cal, event.start, event.allDay);
          let end = event.end ? toDateTime(cal, event.end, event.allDay) : null;
          if (!end) {
            end = start.clone();
            if (start.isDate) {
              end.day += 1;
            } else {
              end.hour += 1;
            }
          } else if (start.isDate && end.compare(start) <= 0) {
            end = start.clone();
            end.day += 1;
          }
          item.startDate = start;
          item.endDate = end;
          if (event.location) {
            item.setProperty("LOCATION", event.location);
          }
          if (event.description) {
            item.setProperty("DESCRIPTION", event.description);
          }
          if (!item.id) {
            item.id = cal.getUUID();
          }
          const r = await settle(cal, "add", item.id, () => calendar.addItem(item));
          return {
            id: r.item?.id ?? item.id,
            calendarId: calendar.id,
            calendarName: calendar.name,
            confirmed: r.confirmed,
          };
        },

        async createTask(task) {
          const { cal, CalTodo } = calModules();
          const calendar = pickCalendar(cal, task.calendarId, "tasks");
          const item = new CalTodo();
          item.title = task.title;
          if (task.due) {
            item.dueDate = toDateTime(cal, task.due);
          }
          if (task.description) {
            item.setProperty("DESCRIPTION", task.description);
          }
          if (!item.id) {
            item.id = cal.getUUID();
          }
          const r = await settle(cal, "add", item.id, () => calendar.addItem(item));
          return {
            id: r.item?.id ?? item.id,
            calendarId: calendar.id,
            calendarName: calendar.name,
            confirmed: r.confirmed,
          };
        },

        async getItem(id, calendarId) {
          const { cal } = calModules();
          const { item } = await findItem(cal, id, calendarId);
          return convertItem(cal, item);
        },

        async updateItem(change) {
          const { cal } = calModules();
          const { calendar, item: old } = await findItem(cal, change.id, change.calendarId);
          const item = old.clone();
          if (change.title != null) {
            item.title = change.title;
          }
          if (change.location != null) {
            item.setProperty("LOCATION", change.location);
          }
          if (change.description != null) {
            item.setProperty("DESCRIPTION", change.description);
          }
          if (item.isTodo()) {
            if (change.due != null) {
              item.dueDate = change.due ? toDateTime(cal, change.due) : null;
            }
            if (change.start != null) {
              item.entryDate = change.start ? toDateTime(cal, change.start) : null;
            }
            if (change.completed != null) {
              item.isCompleted = change.completed;
              item.completedDate = change.completed ? cal.dtz.now() : null;
              item.percentComplete = change.completed ? 100 : 0;
            }
          } else {
            const allDay = change.allDay ?? item.startDate?.isDate;
            if (change.start != null) {
              const duration = item.endDate.subtractDate(item.startDate);
              item.startDate = toDateTime(cal, change.start, allDay);
              if (change.end == null) {
                const end = item.startDate.clone();
                end.addDuration(duration);
                item.endDate = end;
              }
            }
            if (change.end != null) {
              item.endDate = toDateTime(cal, change.end, allDay);
            }
          }
          const r = await settle(cal, "modify", item.id, () => calendar.modifyItem(item, old));
          return { ...convertItem(cal, item), confirmed: r.confirmed };
        },

        async deleteItem(id, calendarId) {
          const { cal } = calModules();
          const { calendar, item } = await findItem(cal, id, calendarId);
          const r = await settle(cal, "delete", item.id, () => calendar.deleteItem(item));
          return { title: item.title || "", calendarName: calendar.name, confirmed: r.confirmed };
        },
      },
    };
    // Errors from chrome code reach the extension only as ExtensionError;
    // anything else becomes "An unexpected error occurred".
    for (const [name, fn] of Object.entries(api.aiCalendar)) {
      api.aiCalendar[name] = async (...args) => {
        try {
          return await fn(...args);
        } catch (e) {
          if (e instanceof ExtensionError) {
            throw e;
          }
          console.error(`AI assistant calendar ${name}:`, e);
          throw new ExtensionError(String(e?.message || e));
        }
      };
    }
    return api;
  }
};
