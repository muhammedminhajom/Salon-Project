import { cache } from "react";

export const requestTime = cache(() => Date.now());
