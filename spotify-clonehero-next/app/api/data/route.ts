export async function GET(request: Request) {
  return Response.json({
    // Increment this if you want to force clients to redownload server data
    chartsDataVersion: 2,
  });
}

// Revision 2: Dedupe by groupId and not my md5. Was previously
// showing multiple charts for the same song/charter
// Revision 1: Initial revision
