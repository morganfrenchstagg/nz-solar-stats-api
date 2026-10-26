-- Migration number: 0006 	 2026-10-26T08:00:00.000Z
-- A farm connected straight to the grid can turn up at more than one NSP in a
-- month (Tauhei at Piako and Waihou, May 2026), so steps are keyed by NSP too.
CREATE TABLE dispatched_solar_steps_by_nsp (
    node TEXT NOT NULL,
    name TEXT NOT NULL,
    nsp TEXT NOT NULL,
    month_end TEXT NOT NULL,
    mw REAL NOT NULL,
    PRIMARY KEY (node, nsp, month_end)
);
INSERT INTO dispatched_solar_steps_by_nsp SELECT node, name, nsp, month_end, mw FROM dispatched_solar_steps;
DROP TABLE dispatched_solar_steps;
ALTER TABLE dispatched_solar_steps_by_nsp RENAME TO dispatched_solar_steps;
