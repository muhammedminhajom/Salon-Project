CREATE TABLE "BranchHoliday" (
    "branchId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "BranchHoliday_pkey" PRIMARY KEY ("branchId", "date"),
    CONSTRAINT "branch_holiday_calendar_date" CHECK ("date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    CONSTRAINT "BranchHoliday_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
