import * as EventBridge from '@aws-sdk/client-eventbridge';
import * as Lambda from '@aws-sdk/client-lambda';
import AWSLambda from 'aws-lambda';
import console from 'console';
import HttpStatus from 'http-status';
import * as Luxon from 'luxon';
import * as process from 'process';
import * as Uuid from 'uuid';
import * as CronUtils from '../lib/cron-utils';
import * as EventDetail from '../lib/event-detail';
import * as Reservation from '../lib/reservation';
import * as ResponseUtils from '../lib/response-utils';
import * as SwClient from '../lib/sw-client';
import * as Timezone from '../lib/timezones';

interface RequestBody {
  data: {
    confirmation_number: string;
    first_name: string;
    last_name: string;
  };
}

/**
 * On scheduled check in, check a user in
 */
export async function handle(event: AWSLambda.APIGatewayProxyEvent) {
  let result: AWSLambda.APIGatewayProxyResult;

  try {
    result = await handleInternal(event);
  } catch (error) {
    console.error(error);

    const result: AWSLambda.APIGatewayProxyResult = {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      headers: ResponseUtils.getStandardResponseHeaders(),
      body: JSON.stringify({ error: 'Internal server error', error_code: 'internal_server_error' })
    };

    return result;
  }

  return result;
}

async function handleInternal(event: AWSLambda.APIGatewayProxyEvent) {
  const requestBody = JSON.parse(event.body);

  if (!isRequestBody(requestBody)) {
    const result: AWSLambda.APIGatewayProxyResult = {
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      headers: ResponseUtils.getStandardResponseHeaders(),
      body: JSON.stringify({ error: 'Invalid parameters', error_code: 'invalid_parameters' })
    };

    return result;
  }

  const reservation: Reservation.Reservation = {
    confirmationNumber: requestBody.data.confirmation_number,
    firstName: requestBody.data.first_name,
    lastName: requestBody.data.last_name
  };

  const allDepartureDates = await findAllDepartureLegs(reservation);

  if (!allDepartureDates) {
    const result: AWSLambda.APIGatewayProxyResult = {
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      headers: ResponseUtils.getStandardResponseHeaders(),
      body: JSON.stringify({ error: 'No future legs found', error_code: 'no_future_legs' })
    };
    return result;
  }

  const checkinAvailableDateTimes = allDepartureDates.map(date => date.minus({
    hours:24
  }))
  
  console.debug('allDepartureDates:', allDepartureDates.map(date => date.toJSDate()));

  // start checking in 5 minutes early (gives time for EventBridge trigger, Lambda cold start,
  // generating advanced checkin headers, etc.)
  const responseBody: ResponseBody = {  
    data: {
      checkin_available_epoch: [],
      checkin_boot_epoch: [],
}};
  for (const checkinAvailableDateTime of checkinAvailableDateTimes) {
    const invokeLambdaDateTime = checkinAvailableDateTime.minus({ minutes: 5 });
    // TODO: hash first and last name into a single string
    const ruleName =
      `${reservation.confirmationNumber}-${reservation.firstName}-` +
      `${reservation.lastName}-${invokeLambdaDateTime.toSeconds()}`;

    const cronExpression = CronUtils.generateCronExpressionUtc(invokeLambdaDateTime.toJSDate());

    console.debug('cronExpression', cronExpression);

    await putRule(ruleName, cronExpression);

    const detail: EventDetail.Detail = {
      reservation,
      checkin_available_epoch: checkinAvailableDateTime.toSeconds()
    };

    const targetId = Uuid.v4();

    await putTarget(ruleName, targetId, detail);

    await addLambdaPermission(ruleName, targetId);

    responseBody.data.checkin_available_epoch.push(Math.floor(checkinAvailableDateTime.toSeconds()))
    responseBody.data.checkin_boot_epoch.push(Math.floor(invokeLambdaDateTime.toSeconds()))

  }

  const result: AWSLambda.APIGatewayProxyResult = {
      statusCode: HttpStatus.OK,
      headers: ResponseUtils.getStandardResponseHeaders(),
      body: JSON.stringify(responseBody)
  };
  return result;
}

async function findAllDepartureLegs(reservation: Reservation.Reservation) {
  const body = await SwClient.getReservation(reservation);

  const validLegs = [];

  for (const leg of body['bounds']) {
    const airportTimezone = await Timezone.fetchAirportTimezone(leg.departureAirport.code);

    // TODO: consider finding a better way to turn these strings into a DateTime
    const takeoff = `${leg.departureDate} ${leg.departureTime}`;
    const takeoffDateTime = Luxon.DateTime.fromFormat(takeoff, 'yyyy-MM-dd HH:mm', {
      zone: airportTimezone
    });

    console.debug('takeoffDateTime', takeoffDateTime.toUTC().toISO());

    validLegs.push(takeoffDateTime);
  }

  if (validLegs.length < 1) {
    return;
  }

  return validLegs;
}

function putRule(ruleName: string, cronExpression: string) {
  const client = new EventBridge.EventBridgeClient({});

  const putRuleCommand = new EventBridge.PutRuleCommand({
    Name: ruleName,
    ScheduleExpression: `cron(${cronExpression})`
  });

  return client.send(putRuleCommand);
}

function putTarget(ruleName: string, targetId: string, detail: Record<string, any>) {
  const client = new EventBridge.EventBridgeClient({});

  const putTargetsCommand = new EventBridge.PutTargetsCommand({
    Rule: ruleName,
    Targets: [
      {
        Id: targetId,
        Arn:
          `arn:aws:lambda:${process.env.AWS_REGION}:${process.env.ACCOUNT_ID}:` +
          `function:checkin-service-prod-HandleScheduledCheckin`,
        Input: JSON.stringify(detail)
      }
    ]
  });

  return client.send(putTargetsCommand);
}

function addLambdaPermission(ruleName: string, targetId: string) {
  const lambda = new Lambda.Lambda({});

  const addPermissionCommand = new Lambda.AddPermissionCommand({
    FunctionName: 'checkin-service-prod-HandleScheduledCheckin',
    StatementId: targetId,
    Action: 'lambda:InvokeFunction',
    Principal: 'events.amazonaws.com',
    SourceArn: `arn:aws:events:${process.env.AWS_REGION}:${process.env.ACCOUNT_ID}:rule/${ruleName}`
  });

  return lambda.send(addPermissionCommand);
}

function isRequestBody(value: any): value is RequestBody {
  return !!(
    value &&
    value.data &&
    value.data.confirmation_number &&
    value.data.first_name &&
    value.data.last_name
  );
}

interface ResponseBody {
  data: {
    checkin_available_epoch: number[];
    checkin_boot_epoch: number[];
  };
}
