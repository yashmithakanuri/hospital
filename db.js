const { DynamoDBClient, DescribeTableCommand, CreateTableCommand } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const TABLE_NAMES = {
  users: process.env.DYNAMODB_USERS_TABLE || "hospital_users",
  doctors: process.env.DYNAMODB_DOCTORS_TABLE || "hospital_doctors",
  appointments: process.env.DYNAMODB_APPOINTMENTS_TABLE || "hospital_appointments",
  counters: process.env.DYNAMODB_COUNTERS_TABLE || "hospital_counters",
};

const ddbClient = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.AWS_DYNAMODB_ENDPOINT ? { endpoint: process.env.AWS_DYNAMODB_ENDPOINT } : {}),
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
        },
      }
    : {}),
});

const docClient = DynamoDBDocumentClient.from(ddbClient);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDateTimeStamp() {
  return new Date().toISOString();
}

function normalizeItem(item) {
  if (!item) {
    return null;
  }

  const normalized = { ...item };

  if (normalized.id !== undefined) {
    normalized.id = Number(normalized.id);
  }

  if (normalized.user_id !== undefined) {
    normalized.user_id = Number(normalized.user_id);
  }

  if (normalized.doctor_id !== undefined) {
    normalized.doctor_id = Number(normalized.doctor_id);
  }

  if (normalized.fees !== undefined) {
    normalized.fees = Number(normalized.fees);
  }

  return normalized;
}

async function ensureTable(definition) {
  const { TableName, KeySchema, AttributeDefinitions, GlobalSecondaryIndexes = [] } = definition;

  try {
    await ddbClient.send(new DescribeTableCommand({ TableName }));
    return;
  } catch (error) {
    if (error.name !== "ResourceNotFoundException") {
      throw error;
    }
  }

  await ddbClient.send(
    new CreateTableCommand({
      TableName,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema,
      AttributeDefinitions,
      GlobalSecondaryIndexes,
    })
  );

  let attempts = 0;
  while (attempts < 30) {
    await sleep(1000);
    const result = await ddbClient.send(new DescribeTableCommand({ TableName }));
    if (result.Table && result.Table.TableStatus === "ACTIVE") {
      return;
    }
    attempts += 1;
  }
}

async function ensureDynamoTables() {
  await ensureTable({
    TableName: TABLE_NAMES.users,
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
      { AttributeName: "email", AttributeType: "S" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "emailIndex",
        KeySchema: [
          { AttributeName: "email", KeyType: "HASH" },
          { AttributeName: "pk", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  });

  await ensureTable({
    TableName: TABLE_NAMES.doctors,
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ],
  });

  await ensureTable({
    TableName: TABLE_NAMES.appointments,
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
      { AttributeName: "doctor_id", AttributeType: "N" },
      { AttributeName: "slot_key", AttributeType: "S" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "doctorSlotIndex",
        KeySchema: [
          { AttributeName: "doctor_id", KeyType: "HASH" },
          { AttributeName: "slot_key", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  });

  await ensureTable({
    TableName: TABLE_NAMES.counters,
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ],
  });
}

async function getNextSequence(tableName) {
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.counters,
      Key: { pk: `COUNTER#${tableName}`, sk: "meta" },
      UpdateExpression: "SET #value = if_not_exists(#value, :zero) + :increment",
      ExpressionAttributeNames: { "#value": "value" },
      ExpressionAttributeValues: { ":zero": 0, ":increment": 1 },
      ReturnValues: "UPDATED_NEW",
    })
  );

  return Number(result.Attributes.value);
}

async function ensureSeedData() {
  const adminExists = await findUserByEmail("admin@gmail.com");
  if (!adminExists) {
    await createUser({
      full_name: "System Admin",
      email: "admin@gmail.com",
      password: "admin123",
      mobile: "9999999999",
      role: "admin",
    });
  }

  const doctors = await listDoctors();
  if (doctors.length === 0) {
    await createDoctor({
      doctor_name: "Dr. Ananya Rao",
      specialization: "Cardiologist",
      schedule: "Mon - Sat | 10:00 AM - 2:00 PM",
      fees: 600,
    });

    await createDoctor({
      doctor_name: "Dr. Vikram Mehta",
      specialization: "Dermatologist",
      schedule: "Mon - Fri | 3:00 PM - 7:00 PM",
      fees: 450,
    });
  }
}

async function findUserByEmail(email) {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.users,
      IndexName: "emailIndex",
      KeyConditionExpression: "email = :email",
      ExpressionAttributeValues: {
        ":email": String(email).trim().toLowerCase(),
      },
    })
  );

  const user = (result.Items || [])[0] || null;
  return user ? normalizeItem(user) : null;
}

async function createUser({ full_name, email, password, mobile, role }) {
  const id = await getNextSequence("users");
  const timestamp = getDateTimeStamp();
  const user = {
    pk: `USER#${id}`,
    sk: "PROFILE",
    id,
    full_name: full_name.trim(),
    email: email.trim().toLowerCase(),
    password,
    mobile: mobile.trim(),
    role,
    is_active: true,
    created_at: timestamp,
    updated_at: timestamp,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.users,
      Item: user,
    })
  );

  return normalizeItem(user);
}

async function findUserByCredentials(email, password, role) {
  const user = await findUserByEmail(email);

  if (!user) {
    return null;
  }

  if (user.password !== password || user.role !== role || user.is_active !== true) {
    return null;
  }

  return normalizeItem(user);
}

async function listDoctors() {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAMES.doctors,
      FilterExpression: "attribute_not_exists(is_active) OR is_active = :active",
      ExpressionAttributeValues: {
        ":active": true,
      },
    })
  );

  return (result.Items || []).map(normalizeItem).sort((a, b) => Number(b.id) - Number(a.id));
}

async function getDoctorById(doctorId) {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.doctors,
      Key: { pk: `DOCTOR#${doctorId}`, sk: "PROFILE" },
    })
  );

  return result.Item ? normalizeItem(result.Item) : null;
}

async function createDoctor({ doctor_name, specialization, schedule, fees }) {
  const id = await getNextSequence("doctors");
  const timestamp = getDateTimeStamp();
  const doctor = {
    pk: `DOCTOR#${id}`,
    sk: "PROFILE",
    id,
    doctor_name: doctor_name.trim(),
    specialization: specialization.trim(),
    schedule: schedule.trim(),
    fees: Number(fees),
    is_active: true,
    created_at: timestamp,
    updated_at: timestamp,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.doctors,
      Item: doctor,
    })
  );

  return normalizeItem(doctor);
}

async function updateDoctor(doctorId, { doctor_name, specialization, schedule, fees }) {
  const existingDoctor = await getDoctorById(doctorId);

  if (!existingDoctor) {
    return null;
  }

  const updatedDoctor = {
    ...existingDoctor,
    doctor_name: doctor_name.trim(),
    specialization: specialization.trim(),
    schedule: schedule.trim(),
    fees: Number(fees),
    updated_at: getDateTimeStamp(),
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.doctors,
      Item: {
        pk: `DOCTOR#${doctorId}`,
        sk: "PROFILE",
        ...updatedDoctor,
      },
    })
  );

  return normalizeItem(updatedDoctor);
}

async function deleteDoctor(doctorId) {
  const existingDoctor = await getDoctorById(doctorId);

  if (!existingDoctor) {
    return null;
  }

  const updatedDoctor = {
    ...existingDoctor,
    is_active: false,
    updated_at: getDateTimeStamp(),
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.doctors,
      Item: {
        pk: `DOCTOR#${doctorId}`,
        sk: "PROFILE",
        ...updatedDoctor,
      },
    })
  );

  return normalizeItem(updatedDoctor);
}

async function scanAppointments() {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAMES.appointments,
    })
  );

  return (result.Items || []).map(normalizeItem);
}

async function listAppointmentsForAdmin() {
  const appointments = await scanAppointments();

  const list = await Promise.all(
    appointments.map(async (appointment) => {
      const patient = await findUserById(appointment.user_id);
      const doctor = await getDoctorById(appointment.doctor_id);

      return {
        ...appointment,
        patient_name: patient ? patient.full_name : "Unknown patient",
        patient_email: patient ? patient.email : "",
        patient_mobile: patient ? patient.mobile : "",
        doctor_name: doctor ? doctor.doctor_name : "Unknown doctor",
        specialization: doctor ? doctor.specialization : "",
      };
    })
  );

  return list.sort((a, b) => {
    const left = `${a.appointment_date} ${a.appointment_time}`;
    const right = `${b.appointment_date} ${b.appointment_time}`;
    return left > right ? -1 : left < right ? 1 : 0;
  });
}

async function findUserById(userId) {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.users,
      KeyConditionExpression: "pk = :pk AND sk = :sk",
      ExpressionAttributeValues: {
        ":pk": `USER#${userId}`,
        ":sk": "PROFILE",
      },
    })
  );

  const item = (result.Items || [])[0] || null;
  return item ? normalizeItem(item) : null;
}

async function listAppointmentsForPatient(userId) {
  const appointments = await scanAppointments();

  const patientAppointments = appointments.filter((appointment) => Number(appointment.user_id) === Number(userId));

  const list = await Promise.all(
    patientAppointments.map(async (appointment) => {
      const doctor = await getDoctorById(appointment.doctor_id);
      return {
        ...appointment,
        doctor_name: doctor ? doctor.doctor_name : "Unknown doctor",
        specialization: doctor ? doctor.specialization : "",
        schedule: doctor ? doctor.schedule : "",
        fees: doctor ? doctor.fees : 0,
      };
    })
  );

  return list.sort((a, b) => {
    const left = `${a.appointment_date} ${a.appointment_time}`;
    const right = `${b.appointment_date} ${b.appointment_time}`;
    return left > right ? -1 : left < right ? 1 : 0;
  });
}

async function findAppointmentSlot(doctorId, appointmentDate, appointmentTime) {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.appointments,
      IndexName: "doctorSlotIndex",
      KeyConditionExpression: "doctor_id = :doctorId AND slot_key = :slotKey",
      FilterExpression: "status <> :cancelled",
      ExpressionAttributeValues: {
        ":doctorId": Number(doctorId),
        ":slotKey": `${appointmentDate}#${appointmentTime}`,
        ":cancelled": "Cancelled",
      },
    })
  );

  const item = (result.Items || [])[0] || null;
  return item ? normalizeItem(item) : null;
}

async function createAppointment({ user_id, doctor_id, appointment_date, appointment_time, reason }) {
  const id = await getNextSequence("appointments");
  const timestamp = getDateTimeStamp();
  const appointment = {
    pk: `APPOINTMENT#${id}`,
    sk: "DETAIL",
    id,
    user_id: Number(user_id),
    doctor_id: Number(doctor_id),
    appointment_date,
    appointment_time,
    slot_key: `${appointment_date}#${appointment_time}`,
    reason: reason.trim(),
    status: "Booked",
    created_at: timestamp,
    updated_at: timestamp,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.appointments,
      Item: appointment,
    })
  );

  return normalizeItem(appointment);
}

async function cancelAppointment(appointmentId, actor) {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.appointments,
      KeyConditionExpression: "pk = :pk AND sk = :sk",
      ExpressionAttributeValues: {
        ":pk": `APPOINTMENT#${appointmentId}`,
        ":sk": "DETAIL",
      },
    })
  );

  const item = (result.Items || [])[0];
  if (!item) {
    return null;
  }

  if (actor.role !== "admin" && Number(item.user_id) !== Number(actor.id)) {
    return null;
  }

  const updated = {
    ...item,
    status: "Cancelled",
    updated_at: getDateTimeStamp(),
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.appointments,
      Item: updated,
    })
  );

  return normalizeItem(updated);
}

async function getAdminStats() {
  const [doctors, patients, appointments, booked] = await Promise.all([
    docClient.send(
      new ScanCommand({
        TableName: TABLE_NAMES.doctors,
        FilterExpression: "attribute_not_exists(is_active) OR is_active = :active",
        ExpressionAttributeValues: { ":active": true },
      })
    ),
    docClient.send(
      new ScanCommand({
        TableName: TABLE_NAMES.users,
        FilterExpression: "role = :role AND (attribute_not_exists(is_active) OR is_active = :active)",
        ExpressionAttributeValues: { ":role": "patient", ":active": true },
      })
    ),
    docClient.send(new ScanCommand({ TableName: TABLE_NAMES.appointments })),
    docClient.send(
      new ScanCommand({
        TableName: TABLE_NAMES.appointments,
        FilterExpression: "status = :status",
        ExpressionAttributeValues: { ":status": "Booked" },
      })
    ),
  ]);

  return {
    doctors: (doctors.Items || []).length,
    patients: (patients.Items || []).length,
    appointments: (appointments.Items || []).length,
    activeBookings: (booked.Items || []).length,
  };
}

module.exports = {
  ensureDynamoTables,
  ensureSeedData,
  findUserByEmail,
  createUser,
  findUserByCredentials,
  listDoctors,
  getDoctorById,
  createDoctor,
  updateDoctor,
  deleteDoctor,
  listAppointmentsForAdmin,
  listAppointmentsForPatient,
  findAppointmentSlot,
  createAppointment,
  cancelAppointment,
  getAdminStats,
  findUserById,
};
