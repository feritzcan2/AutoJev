// SQLite row helpers shared by the automation store modules.
export const json = (row) => (row ? JSON.parse(row.data) : null);
export const finishedSourceRun =
  "json_extract(data,'$.kind') IN ('run','trial') AND json_extract(data,'$.status')<>'running' AND json_extract(data,'$.recordId') IS NULL AND json_extract(data,'$.recordOperation') IS NULL";
export const runSource =
  "coalesce(json_extract(data,'$.sourceUrl'),CASE WHEN json_array_length(data,'$.sources')=1 THEN json_extract(data,'$.sources[0]') END)";
