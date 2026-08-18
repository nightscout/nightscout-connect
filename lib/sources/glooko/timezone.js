function isValidTimezone (timeZone) {
  if (!timeZone) {
    return true;
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch (err) {
    return false;
  }
}

function timezoneOffsetAt (date, timeZone) {
  var formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  var parts = formatter.formatToParts(date)
    .reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});

  var localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
    date.getUTCMilliseconds()
  );

  return localAsUtc - date.getTime();
}

function timestampWithTimezone (timestamp, timeZone) {
  var wallTime = new Date(timestamp);
  var wallTimeMs = wallTime.getTime();

  var offset = timezoneOffsetAt(wallTime, timeZone);
  var result = new Date(wallTimeMs - offset);

  var resolvedOffset = timezoneOffsetAt(result, timeZone);
  if (resolvedOffset !== offset) {
    result = new Date(wallTimeMs - resolvedOffset);
  }

  return result;
}

function timestampWithOffset (timestamp, timestampDelta, timeZone) {
  if (timeZone) {
    return timestampWithTimezone(timestamp, timeZone);
  }

  return new Date(new Date(timestamp).getTime() + (timestampDelta || 0));
}

module.exports = {
  isValidTimezone,
  timestampWithOffset
};
