// The refusals a server maps to a status, shared by the remote extension and the lane artifacts the core keeps.
import { GovernError } from "./util.ts";

/** A malformed request (400). Any GovernError that is none of these four is a state conflict (409). */
export class BadRequest extends GovernError {}
/** A signature, clock, nonce or code that does not prove the request (403). */
export class Forbidden extends GovernError {}
/** A lane or artifact that does not exist (404). */
export class NotFound extends GovernError {}
/** A body over the limit (413). */
export class TooLarge extends GovernError {}
